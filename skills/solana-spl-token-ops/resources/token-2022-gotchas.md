# Token-2022 Operational Gotchas for Everyday Transfers

Token-2022 mints are a superset of classic mints, but three extensions change how a plain transfer behaves. If your code assumes "amount sent equals amount received" or "a transfer needs only the standard accounts," it breaks on these mints. Detect them from the mint's extensions and handle each.

For creating and configuring extension mints (fees, metadata, hooks, soulbound), load the `token-2022` skill. This file covers only what an everyday transfer flow must do when it encounters such a mint.

## Detect extensions on a mint

```ts
import { getMint, getExtensionTypes, ExtensionType, getTransferFeeConfig } from "@solana/spl-token";

const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
const extensions = getExtensionTypes(mintInfo.tlvData);
const hasFee = extensions.includes(ExtensionType.TransferFeeConfig);
const hasHook = extensions.includes(ExtensionType.TransferHook);
const isNonTransferable = extensions.includes(ExtensionType.NonTransferable);
```

A classic mint has no `tlvData` and none of these. Only Token-2022 mints can carry extensions, so detect the program first (see `ata-and-programs.md`).

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

- A plain `transferChecked` works on a fee mint (the program applies the fee). For deterministic fee handling at the instruction level, the `token-2022` skill covers `transferCheckedWithFee` and the harvest/withdraw lifecycle. For an everyday send, use `transferChecked` and trust the balance delta.

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

## Quick handling table

| Extension | Symptom if ignored | Handle by |
|-----------|--------------------|-----------|
| `TransferFeeConfig` | Downstream accounting overcounts; recipient short | Read the balance delta; expect `received = amount - fee` |
| `TransferHook` | Transfer fails with missing accounts | Use `createTransferCheckedWithTransferHookInstruction` to resolve and append extra accounts |
| `NonTransferable` | Transfer reverts | Detect and refuse to attempt the transfer |

Other extensions (`PermanentDelegate`, `DefaultAccountState` frozen, `ConfidentialTransfer`) also affect behavior; see the `token-2022` skill when you encounter them.
