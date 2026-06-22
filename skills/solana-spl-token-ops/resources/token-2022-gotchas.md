# Token-2022 Operational Gotchas for Everyday Transfers

Token-2022 mints are a superset of classic mints, and a handful of extensions change how a plain transfer behaves, whether an account can close, and whether amount accounting is even valid. If your code assumes "amount sent equals amount received," "a transfer needs only the standard accounts," or "a zero-balance account always closes," it breaks on these mints. Detect them from the mint and account extensions and handle each.

For creating and configuring extension mints (fees, metadata, hooks, soulbound), load the `token-2022` skill. This file covers only what an everyday transfer, balance, and close flow must do when it encounters such a mint.

## Never infer account type from byte length on Token-2022

Classic token accounts are a fixed 165 bytes, so older code sometimes branched on `data.length`. Token-2022 accounts are **variable length**: the base account is followed by a type byte and a TLV list of account-level extensions, so two accounts of the same kind can differ in size. Never infer the account type or program from byte length. Always deserialize with `getAccount` (or `unpackAccount` for raw account data); they read the account type tag and parse the TLV correctly.

## Detect extensions on a mint

```ts
import {
  getMint,
  getExtensionTypes,
  ExtensionType,
  getTransferFeeConfig,
  getPermanentDelegate,
  getMintCloseAuthority,
  getPausableConfig,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
const extensions = getExtensionTypes(mintInfo.tlvData);
const hasFee = extensions.includes(ExtensionType.TransferFeeConfig);
const hasHook = extensions.includes(ExtensionType.TransferHook);
const isNonTransferable = extensions.includes(ExtensionType.NonTransferable);
const isDefaultFrozen = extensions.includes(ExtensionType.DefaultAccountState);
const hasPermanentDelegate = extensions.includes(ExtensionType.PermanentDelegate);
const isPausable = extensions.includes(ExtensionType.PausableConfig);
const hasMintCloseAuthority = extensions.includes(ExtensionType.MintCloseAuthority);
const isConfidential = extensions.includes(ExtensionType.ConfidentialTransferMint);
```

Account-level extensions live on the **token account**, not the mint. Required-memo and CPI guard are account-level; read them from a `getAccount` result:

```ts
import { getAccount, getMemoTransfer, getCpiGuard } from "@solana/spl-token";

const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
const requiresMemo = getMemoTransfer(acct)?.requireIncomingTransferMemos ?? false;
const cpiGuardOn = getCpiGuard(acct)?.lockCpi ?? false;
```

A classic mint has no `tlvData` and none of these. Only Token-2022 mints and accounts can carry extensions, so detect the program first (see `ata-and-programs.md`).

## 1. Transfer fee: recipient gets less than was sent

A mint with `TransferFeeConfig` withholds a fee on every transfer. The fee is deducted from the transferred amount and parked on the recipient's token account as "withheld" tokens; the recipient's spendable balance is `amount - fee`.

- Fee formula: `fee = min(amount * feeBasisPoints / 10000, maxFee)`. Read `feeBasisPoints` and `maxFee` from `getTransferFeeConfig(mintInfo).newerTransferFee`.
- Do **not** assume `received == amount`. Read the actual on-chain balance delta:

```ts
import { getAccount } from "@solana/spl-token";

const before = (await getAccount(connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
// ... send the transfer ...
const after = (await getAccount(connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
const actuallyReceived = after - before; // this, not the sent amount, drives downstream accounting
```

- A plain `transferChecked` works on a fee mint (the program applies the fee). For a deterministic path where the client sets the fee, use `createTransferCheckedWithFeeInstruction(source, mint, destination, authority, amount, decimals, fee, [], programId)` with `fee = min(amount * feeBasisPoints / 10000, maxFee)`; the transaction reverts if the fee is wrong. For an everyday send, use `transferChecked` and trust the balance delta.

### Withheld fees block closing

The fee withheld on each transfer accrues on the **recipient** account as withheld tokens, separate from its spendable balance. A token account that holds withheld fees cannot be closed even when its spendable balance is zero. Before closing, harvest the withheld fees back to the mint:

```ts
import { getAccount, getTransferFeeAmount, harvestWithheldTokensToMint } from "@solana/spl-token";

const acct = await getAccount(connection, account, "confirmed", TOKEN_2022_PROGRAM_ID);
const withheld = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;
if (withheld > 0n) {
  await harvestWithheldTokensToMint(connection, payer, mint, [account], undefined, TOKEN_2022_PROGRAM_ID);
}
// now the account can be closed with createCloseAccountInstruction
```

`harvestWithheldTokensToMint` is permissionless: anyone can sweep withheld tokens from accounts to the mint, after which the mint's withdraw authority moves them out. For an everyday close-for-rent flow you only need the harvest so the account empties and closes.

## 2. Transfer hook: the transfer needs extra accounts

A mint with `TransferHook` calls a separate hook program on every transfer. That program declares an `ExtraAccountMetaList` PDA listing additional accounts the transfer instruction must include. A standard `transferChecked` that omits them fails with a missing-accounts error.

Resolve and append them automatically with the hook-aware helper:

```ts
import { createTransferCheckedWithTransferHookInstruction } from "@solana/spl-token";

const ix = await createTransferCheckedWithTransferHookInstruction(
  connection,
  sourceAta,
  mint,
  destAta,
  owner,
  amount,
  decimals,
  [],            // multisig signers
  "confirmed",
  TOKEN_2022_PROGRAM_ID
);
```

This reads the hook program id and its `ExtraAccountMetaList`, resolves the extra account metas, and appends them. Notes:

- The hook program runs arbitrary logic and can reject a transfer (allowlists, fees, KYC). Surface its failure to the user.
- Many wallets, DEXs, and bridges cannot resolve hook accounts. Verify the target venue supports transfer-hook mints before relying on it.

## 3. Non-transferable (soulbound): transfers are rejected

A mint with `NonTransferable` cannot be moved at all. Any transfer reverts. Detect it and do not attempt the send.

```ts
if (isNonTransferable) {
  throw new Error("this mint is non-transferable (soulbound); it cannot be sent");
}
```

The holder can still close their token account (which burns the soulbound balance) to reclaim rent, but the token cannot change owners.

## 4. Default account state frozen: new ATAs are created frozen

A mint with `DefaultAccountState` set to frozen creates every new token account, including a freshly made ATA, in the frozen state. Transfers into or out of a frozen account fail until the mint's freeze authority thaws it. After creating the ATA, check its state and surface a clear error instead of blindly sending.

```ts
import { getAccount, AccountState, getDefaultAccountState } from "@solana/spl-token";

const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
if (acct.isFrozen) { // the parsed Account exposes isFrozen, not a raw `state` field
  throw new Error("ATA is frozen (mint default-frozen); the freeze authority must thaw it before transfers");
}
// up front, the mint's policy: getDefaultAccountState(mintInfo)?.state === AccountState.Frozen
```

Detect: `extensions.includes(ExtensionType.DefaultAccountState)` plus `getDefaultAccountState(mintInfo).state === AccountState.Frozen` on the mint, or `getAccount(...).isFrozen` on the account. Handle: the freeze authority must `thawAccount` before transfers; do not attempt a send into a frozen account.

## 5. Permanent delegate: a third party can move or burn any balance

A mint with `PermanentDelegate` names an authority that can transfer or burn tokens from **any** holder's account without that holder's signature. This is a custody risk: tokens you "hold" are not exclusively yours.

```ts
import { getPermanentDelegate } from "@solana/spl-token";
const pd = getPermanentDelegate(mintInfo); // { delegate } or null
if (pd) {
  console.warn(`permanent delegate ${pd.delegate.toBase58()} can move or burn any balance of this mint`);
}
```

Detect: `getPermanentDelegate(mintInfo)` returns non-null. Handle: for escrow, vault, or treasury logic, treat this mint as not fully under the holder's control and warn before accepting it as collateral or backing.

## 6. Required memo on transfer: a transfer with no memo fails

An account with `MemoTransfer` (RequiredMemoOnTransfer) enabled rejects any incoming transfer that is not immediately preceded by a memo instruction in the same transaction. This is an account-level setting on the **destination**.

```ts
import { getAccount, getMemoTransfer } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

const dest = await getAccount(connection, destAta, "confirmed", TOKEN_2022_PROGRAM_ID);
if (getMemoTransfer(dest)?.requireIncomingTransferMemos) {
  // prepend a memo instruction BEFORE the transfer in the same transaction
  const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
  const memoIx = new TransactionInstruction({
    keys: [],
    programId: MEMO_PROGRAM_ID,
    data: Buffer.from("transfer note", "utf8"),
  });
  tx.add(memoIx); // then add the transferChecked instruction after it
}
```

If `@solana/spl-memo` is installed, `createMemoInstruction("transfer note")` builds the same instruction. Detect: `getMemoTransfer(destAccount).requireIncomingTransferMemos`. Handle: prepend a memo instruction in the same transaction, before the transfer.

## 7. Pausable: transfers revert while the mint is paused

A mint with `PausableConfig` can be paused by its pause authority. While paused, transfers, mints, and burns revert. Detect the paused state and surface it rather than retrying blindly.

```ts
import { getPausableConfig } from "@solana/spl-token";
const pausable = getPausableConfig(mintInfo); // { authority, paused } or null
if (pausable?.paused) {
  throw new Error("this mint is currently paused; transfers will revert until it is unpaused");
}
```

Detect: `getPausableConfig(mintInfo).paused === true`. Handle: abort and tell the user the mint is paused; do not loop on retries.

## 8. CPI guard: CPI-based transfers and approvals are blocked

An account with CPI guard enabled blocks several actions when they are invoked through a cross-program invocation: transfer, burn, approve, close, and setting a delegate. A program that tries to move a user's tokens via CPI fails unless the user first delegates and the program spends as the delegate.

```ts
import { getAccount, getCpiGuard } from "@solana/spl-token";
const acct = await getAccount(connection, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
if (getCpiGuard(acct)?.lockCpi) {
  // a direct (non-CPI) transfer signed by the owner is fine;
  // a program moving these tokens via CPI must use the delegation flow
}
```

Detect: `getCpiGuard(account).lockCpi === true`. Handle: do not attempt a CPI transfer or approval; use the explicit delegate-then-spend flow, or have the owner sign a direct transfer.

## 9. Mint close authority: a mint is not permanent by address alone

A mint with `MintCloseAuthority` can be closed once its supply is zero, freeing the rent. The address can then be reused by a different account, including a different mint. Do not assume a mint is permanent just because you have seen its address before; verify it on chain each time.

```ts
import { getMintCloseAuthority } from "@solana/spl-token";
const mca = getMintCloseAuthority(mintInfo); // { closeAuthority } or null
if (mca) {
  console.warn(`mint can be closed by ${mca.closeAuthority.toBase58()}; do not treat this address as permanent`);
}
```

Detect: `getMintCloseAuthority(mintInfo)` returns non-null. Handle: re-fetch and re-validate the mint (owner program, decimals, supply) before each use; never cache "this address is mint X" indefinitely.

## 10. Confidential transfer: amounts are encrypted, so delta accounting is invalid

A mint with `ConfidentialTransferMint` lets holders move balances confidentially. The on-chain transferred amount is encrypted, so the public balance delta does not reflect what moved. Any "read the balance before and after" accounting is meaningless for confidential transfers.

```ts
if (extensions.includes(ExtensionType.ConfidentialTransferMint)) {
  throw new Error("confidential-transfer mint: on-chain amounts are encrypted; refuse to reason about exact amounts via balance deltas");
}
```

Detect: `extensions.includes(ExtensionType.ConfidentialTransferMint)`. Handle: refuse to compute or assert exact amounts from public balances; confidential flows need the dedicated confidential-transfer instructions and the holder's encryption keys, which are out of scope for an everyday send.

## Interest-bearing and scaled-UI: raw amount is not the displayed balance

A mint with `InterestBearingConfig` or `ScaledUiAmountConfig` displays a UI amount that differs from the raw stored `amount`. Do not show or compute on the raw `amount` as if it were the balance, and do not do the conversion with JavaScript floats. Use the on-chain conversion helpers:

```ts
import { amountToUiAmount, uiAmountToAmount } from "@solana/spl-token";

const uiString = await amountToUiAmount(connection, payer, mint, rawAmount, TOKEN_2022_PROGRAM_ID);
const rawAgain = await uiAmountToAmount(connection, payer, mint, "1.5", TOKEN_2022_PROGRAM_ID);
```

Both simulate against the program so the rate is exact at the current slot.

## Quick handling table

| Extension | Symptom if ignored | Handle by |
|-----------|--------------------|-----------|
| `TransferFeeConfig` | Downstream accounting overcounts; recipient short; close fails on withheld fees | Read the balance delta (`received = amount - fee`); before closing, `harvestWithheldTokensToMint` if `getTransferFeeAmount(acct).withheldAmount > 0` |
| `TransferHook` | Transfer fails with missing accounts | Use `createTransferCheckedWithTransferHookInstruction` to resolve and append extra accounts |
| `NonTransferable` | Transfer reverts | Detect and refuse to attempt the transfer |
| `DefaultAccountState` (frozen) | New ATA is frozen; transfer fails | Read `getAccount(...).isFrozen`; the freeze authority must thaw it first |
| `PermanentDelegate` | A third party can drain or burn any balance | `getPermanentDelegate(mintInfo)` non-null; warn before using as custody, escrow, or vault backing |
| `MemoTransfer` (account) | Transfer with no memo reverts | `getMemoTransfer(dest).requireIncomingTransferMemos`; prepend a memo instruction in the same tx |
| `PausableConfig` | Transfers revert while paused | `getPausableConfig(mintInfo).paused`; abort and surface, do not loop retries |
| CPI guard (account) | CPI transfer or approval blocked | `getCpiGuard(acct).lockCpi`; use the delegate-then-spend flow or a direct owner-signed transfer |
| `MintCloseAuthority` | Mint can be closed and the address reused | `getMintCloseAuthority(mintInfo)` non-null; re-validate the mint on chain each use |
| `ConfidentialTransferMint` | Encrypted amounts make delta accounting invalid | Detect and refuse to reason about exact amounts from public balances |
| `InterestBearingConfig` / `ScaledUiAmountConfig` | Raw `amount` differs from displayed balance | Convert with `amountToUiAmount` / `uiAmountToAmount`, never JavaScript floats |

For creating or configuring any of these extensions, load the `token-2022` skill. This file covers only what an everyday transfer, balance, and close flow must do when it meets one.
