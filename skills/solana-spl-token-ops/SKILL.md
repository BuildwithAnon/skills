---
name: solana-spl-token-ops
description: Everyday SPL token and Associated Token Account lifecycle on Solana. Covers SPL token transfers, associated token account (ATA) derivation and idempotent creation, reading mint decimals and balances, transferChecked and transferCheckedWithFee, mintTo and burnChecked, wrapping and unwrapping SOL (WSOL, including NATIVE_MINT_2022), closing accounts to reclaim rent (handling withheld transfer fees), and auto-detecting whether a mint uses the classic Token program or Token-2022. Also flags Token-2022 footguns before acting: transfer fees, transfer hooks, non-transferable, default-frozen account state, permanent delegate, required-memo, pausable, CPI guard, mint close authority, and confidential transfers. Load this when a user wants to send a token, create or fund an ATA, wrap or unwrap SOL, convert UI amounts to base units, read a wallet's token balances, close a token account, or work with an arbitrary mint without knowing its token program.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana SPL Token Operations

Two token programs now share Solana, classic Token and Token-2022, and mixing them up is the bug that bites SPL integrations more than any other: derive an ATA with the wrong program id and you get a valid-looking but unrelated address, a confusing `TokenAccountNotFoundError`, and a transfer that goes nowhere. This skill detects which program owns a mint and threads that id through every call, so the everyday flows just work: send tokens, create the recipient's Associated Token Account (ATA) so the transfer lands, read decimals so amounts are right, wrap and unwrap SOL, and close empty accounts to reclaim rent.

This is the action layer for fungible tokens. To mint tokens with extensions (transfer fees, on-chain metadata, hooks, soulbound), load `token-2022`. For NFTs, load the Metaplex skill. For swaps, load Jupiter.

## Overview

A token "balance" on Solana lives in a token account, not on the wallet itself. The canonical token account for a (wallet, mint) pair is the Associated Token Account, a PDA derived from the owner, the mint, and the token program. Three facts drive almost every operation:

1. There are two token programs. Classic Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). A mint belongs to exactly one of them. ATA derivation, transfers, mints, burns, and closes must all use that mint's program id. Pass the wrong one and you derive a different, unrelated address or send to the wrong program. Detect the program by reading the mint account's `owner`; never assume.

2. Amounts are integers in base units, not UI floats. A token with 6 decimals stores 1.5 tokens as `1500000`. The decimals live on the mint, so read them with `getMint`; never hardcode 9. Prefer `transferChecked` (it takes the mint and decimals and reverts on a mismatch) over the unchecked `transfer`.

3. Accounts cost rent. Creating an ATA for someone costs the payer about 0.00204 SOL of rent-exemption. Closing an empty token account returns that rent to the owner. The destination must already have an ATA, or the transfer fails, so create it (idempotently) first.

Token-2022 mints can also change transfer semantics and account behavior: a transfer-fee mint delivers less than was sent and parks a withheld fee that blocks closing, a transfer-hook mint requires extra accounts, a non-transferable mint rejects transfers, a default-frozen mint creates ATAs frozen, a required-memo mint rejects transfers with no memo, a pausable mint reverts while paused, and a confidential-transfer mint encrypts amounts so balance-delta accounting is invalid. Other extensions (permanent delegate, CPI guard, mint close authority) affect custody and lifecycle. Detect these from the mint and account extensions and handle them. Never infer an account's type from its byte length on Token-2022; the layout is variable, so always deserialize with `getAccount` / `unpackAccount`. See `resources/token-2022-gotchas.md`.

## Instructions

Follow this lifecycle. Read the referenced resource file before writing code.

1. Detect the mint's token program. Fetch the mint account and read its owner. Exit criteria: you hold a `programId` that equals either `TOKEN_PROGRAM_ID` or `TOKEN_2022_PROGRAM_ID`, and you pass it to every subsequent ATA derivation, transfer, mint, burn, and close. See `resources/ata-and-programs.md`.
   ```ts
   const info = await connection.getAccountInfo(mint);
   if (!info) throw new Error("mint not found");
   const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID)
     ? TOKEN_2022_PROGRAM_ID
     : TOKEN_PROGRAM_ID;
   ```

2. Derive the ATA with the detected program id. Use `getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, programId, ASSOCIATED_TOKEN_PROGRAM_ID)`. Exit criteria: the derived address matches what an explorer shows for that owner and mint. Set `allowOwnerOffCurve` to `true` only when the owner is a PDA (for example a program vault).

3. Create the ATA idempotently before depositing into it. Use `createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID)` so a re-run or a race does not throw `TokenAccountNotFoundError` on read or "account already in use" on create. Exit criteria: the recipient ATA exists on chain. The payer funds the rent (about 0.00204 SOL). Prefer this over the non-idempotent `createAssociatedTokenAccountInstruction`, which throws if the ATA already exists. For a one-call convenience that both derives and creates (it sends its own transaction and needs a signer), use `getOrCreateAssociatedTokenAccount`; prefer the idempotent instruction when you are batching ATA creation into a single transaction with the transfer.

   On a Token-2022 mint with `DefaultAccountState` set to frozen, the new ATA is created **frozen** and transfers into or out of it fail until the freeze authority thaws it. After creating the ATA, read its state and surface a clear error rather than blindly sending:
   ```ts
   import { getAccount } from "@solana/spl-token";
   const acct = await getAccount(connection, ata, "confirmed", programId);
   if (acct.isFrozen) {
     throw new Error("ATA is frozen (mint default-frozen); the freeze authority must thaw it before transfers");
   }
   ```

4. Read decimals from the mint, never hardcode. Call `getMint(connection, mint, commitment, programId)` and use `mintInfo.decimals`. Convert a UI amount to base units carefully:
   ```ts
   const baseUnits = BigInt(Math.round(uiAmount * 10 ** decimals));
   ```
   Exit criteria: the integer you pass to a transfer reflects the mint's real decimals. For amounts where float rounding is unacceptable, parse the string into base units directly instead of multiplying a float.

5. Move tokens with `transferChecked`, not `transfer`. `transferChecked(connection, payer, source, mint, destination, owner, amount, decimals, [], options, programId)` passes the mint and decimals so the program reverts on a decimals or mint mismatch instead of silently moving the wrong amount. Exit criteria: the transaction confirms and the destination balance increased. On a Token-2022 fee mint, the delivered amount is less than `amount`; read the actual balance delta rather than assuming `received == amount`. See `resources/token-2022-gotchas.md`.

   On a Token-2022 transfer-fee mint there are two correct paths. The everyday path is a plain `transferChecked` (the program applies the fee for you) plus reading the on-chain balance delta as the truth. The deterministic path is `createTransferCheckedWithFeeInstruction(source, mint, destination, authority, amount, decimals, fee, [], programId)`, where the client precomputes the fee and the transaction reverts if it is wrong:
   ```ts
   import { getTransferFeeConfig, createTransferCheckedWithFeeInstruction } from "@solana/spl-token";
   const cfg = getTransferFeeConfig(mintInfo); // mintInfo from getMint
   const { transferFeeBasisPoints, maximumFee } = cfg.newerTransferFee;
   const fee =
     (amount * BigInt(transferFeeBasisPoints)) / 10000n < maximumFee
       ? (amount * BigInt(transferFeeBasisPoints)) / 10000n
       : maximumFee; // fee = min(amount * feeBasisPoints / 10000, maxFee)
   const ix = createTransferCheckedWithFeeInstruction(
     source, mint, destination, owner, amount, decimals, fee, [], programId
   );
   ```

6. Wrap SOL into WSOL when a flow needs the native mint as an SPL token. WSOL mint is `So11111111111111111111111111111111111111112` (9 decimals) and uses the classic Token program. Get or idempotently create the WSOL ATA, `SystemProgram.transfer` lamports into it, then `createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID)` to make the token balance reflect the lamports. Exit criteria: the WSOL ATA's token amount equals the wrapped lamports. See `examples/wrap-unwrap-sol.ts`.

7. Unwrap WSOL or close any empty token account to reclaim rent with `createCloseAccountInstruction(account, destination, owner, [], programId)`. For WSOL this returns both the wrapped lamports and the account rent to the destination. For any other mint the token balance must be zero first (transfer or burn the remainder), then close returns the about 0.00204 SOL rent. Exit criteria: the token account no longer exists and the destination received the lamports.

   On a Token-2022 transfer-fee mint, a token account can hold **withheld fees** even when its spendable balance is zero, and close will fail while withheld tokens remain. Before closing, check the withheld amount and harvest it back to the mint first:
   ```ts
   import { getAccount, getTransferFeeAmount, harvestWithheldTokensToMint } from "@solana/spl-token";
   const acct = await getAccount(connection, account, "confirmed", programId);
   const withheld = getTransferFeeAmount(acct)?.withheldAmount ?? 0n;
   if (withheld > 0n) {
     // harvest the parked fees to the mint so the account can close
     await harvestWithheldTokensToMint(connection, payer, mint, [account], undefined, programId);
   }
   // now createCloseAccountInstruction(account, destination, owner, [], programId)
   ```

8. Read balances when you need them. For one account, `connection.getTokenAccountBalance(ata)` returns `{ amount, decimals, uiAmountString }` in one RPC call, or `getAccount(connection, ata, "confirmed", programId).amount` for the raw `bigint`. To list every token a wallet holds, call `connection.getTokenAccountsByOwner(owner, { programId })` and pass the **right** program id; a Token-2022 holding does not show up under `TOKEN_PROGRAM_ID`, so query both when you do not know which program the holdings use. For interest-bearing or scaled-UI mints the raw `amount` is not the displayed balance: convert with `amountToUiAmount(connection, payer, mint, amount, programId)` (and `uiAmountToAmount` for the reverse). This also keeps you off JavaScript floats. Exit criteria: the displayed balance matches an explorer.

9. Test on devnet first. Airdrop SOL with `connection.requestAirdrop`, run the flow, and verify balances with `getAccount` and `getMint` before doing the same on mainnet with a funded keypair loaded from an env var. Exit criteria: balances and rent reclaim match expectations on devnet.

## Examples

### Send an SPL token to a wallet that may not have an account yet

When the user asks: "Send 25 of this token to that wallet."

The agent should:
1. Detect the mint's program by reading the mint account owner (classic vs Token-2022).
2. Derive the recipient ATA with that program id and create it idempotently (the payer covers the rent).
3. If Token-2022, check the new ATA's state; a default-frozen mint creates it frozen and the transfer will fail until thawed, so surface that instead of sending.
4. Read decimals with `getMint` and convert 25 to base units (`25 * 10 ** decimals`).
5. Call `transferChecked` with the amount, decimals, and detected program id.
6. If the mint is a Token-2022 fee mint, read the recipient balance delta rather than assuming 25 arrived.

Full runnable file: `examples/transfer-token.ts`.

### Wrap SOL to WSOL and unwrap it back

When the user asks: "I need wrapped SOL to interact with this AMM, then give it back."

The agent should:
1. Idempotently create the WSOL ATA (`So11111111111111111111111111111111111111112`, classic Token program).
2. `SystemProgram.transfer` the lamports to wrap into the WSOL ATA, then `createSyncNativeInstruction` so the token balance updates.
3. Use the WSOL like any SPL token.
4. To unwrap, `createCloseAccountInstruction` on the WSOL ATA, which returns the wrapped lamports plus the account rent to the owner.

Full runnable file: `examples/wrap-unwrap-sol.ts`.

### Reclaim rent from a leftover empty token account

When the user asks: "I have a dust token account I no longer need, get my SOL back."

The agent should:
1. Detect the account's token program from the mint owner.
2. On a Token-2022 fee mint, check `getTransferFeeAmount(account).withheldAmount`; if nonzero, `harvestWithheldTokensToMint` first or close will fail even at zero spendable balance.
3. If the balance is nonzero, transfer the remaining tokens out or `burnChecked` them so the account is empty.
4. `createCloseAccountInstruction(account, destination, owner, [], programId)` to return the about 0.00204 SOL rent to the destination.
5. Confirm the account no longer exists with `getAccountInfo`.

### Mint new supply and burn it back

When the user asks: "Mint 1,000 of my token to a holder, then burn 200 of them."

The agent should:
1. Detect the program id, derive the holder ATA with it, and create it idempotently.
2. Mint with the checked variant: `mintToChecked(connection, payer, mint, holderAta, mintAuthority, amount, decimals, [], options, programId)` (or `createMintToCheckedInstruction` to batch). The checked form reverts on a decimals mismatch; only the mint authority can mint.
3. Burn with `burnChecked(connection, payer, holderAta, mint, owner, amount, decimals, [], options, programId)` (or `createBurnCheckedInstruction`). Burning reduces supply and frees the account toward a zero balance for closing.

### Fund a program vault ATA (PDA owner, off curve)

When the user asks: "Create the token account my program's vault PDA owns."

The agent should:
1. Derive the vault PDA with `PublicKey.findProgramAddressSync(seeds, programId)`.
2. Derive its ATA with `allowOwnerOffCurve` set to `true`, because a PDA is off the ed25519 curve and the default `false` throws `TokenOwnerOffCurveError`:
   ```ts
   const vaultAta = getAssociatedTokenAddressSync(
     mint, vaultPda, true /* allowOwnerOffCurve */, programId, ASSOCIATED_TOKEN_PROGRAM_ID
   );
   ```
3. Create it idempotently the same way as any ATA; the payer (a normal wallet) funds the rent, and the PDA's program signs later spends with `invoke_signed`.

## Guidelines

- DO read the mint account owner to detect classic Token vs Token-2022 before acting on any mint you did not create, and thread that program id through every call.
- DO pass `programId` and `ASSOCIATED_TOKEN_PROGRAM_ID` to `getAssociatedTokenAddressSync` and the ATA creation instruction. The wrong token program derives a different ATA.
- DO use `createAssociatedTokenAccountIdempotentInstruction` as the default; it is safe to re-run and survives races.
- DO read decimals with `getMint` and convert UI amounts to base unit `BigInt`s. Never hardcode 9.
- DO use `transferChecked` (mint + decimals) over `transfer`. It reverts on a decimals or mint mismatch instead of moving the wrong amount.
- DO empty a token account (transfer out or burn) before closing any non-WSOL account; close only works on a zero balance.
- DO read the actual recipient balance delta after a transfer on a possible fee mint. Do not assume `received == amount`.
- DO check `getTransferFeeAmount(account).withheldAmount` before closing a Token-2022 fee account; harvest the withheld tokens to the mint first or the close fails even at zero spendable balance.
- DO check the new ATA's `state` on a Token-2022 mint; a `DefaultAccountState` of frozen creates it frozen, so transfers fail until the freeze authority thaws it. Surface this rather than blindly sending.
- DO set `allowOwnerOffCurve` to `true` when the owner is a PDA (a program vault or escrow authority); the default `false` throws `TokenOwnerOffCurveError`.
- DO use the checked variants `mintToChecked` and `burnChecked` over the unchecked `mintTo` and `burn`; they revert on a decimals mismatch.
- DO query `getTokenAccountsByOwner` with the correct program id, and check both `TOKEN_PROGRAM_ID` and `TOKEN_2022_PROGRAM_ID` when you do not know which a wallet's holdings use.
- DO convert raw amounts with `amountToUiAmount` / `uiAmountToAmount` on interest-bearing or scaled-UI mints, where the raw amount is not the displayed balance.
- DO scan a Token-2022 mint for permanent delegate, required memo, pausable, CPI guard, mint close authority, and confidential transfer before relying on it; see `resources/token-2022-gotchas.md`.
- DO test on devnet with an airdrop before running on mainnet.
- DON'T mix program ids. Deriving an ATA with the classic id for a Token-2022 mint (or vice versa) produces a wrong, unrelated address and a confusing `TokenAccountNotFoundError`.
- DON'T deposit into or transfer to an ATA without ensuring it exists first; create it idempotently.
- DON'T multiply large UI amounts as JavaScript numbers where precision matters; parse strings into base units to avoid float rounding.
- DON'T close a token account that still holds tokens or withheld fees; the instruction fails until both are cleared.
- DON'T assume a Token-2022 mint behaves like a plain token; check for transfer fee, transfer hook, non-transferable, default-frozen state, permanent delegate, required memo, pausable, CPI guard, mint close authority, and confidential transfer. See `resources/token-2022-gotchas.md`.
- DON'T infer an account's type from its byte length on Token-2022; the layout is variable, so always deserialize with `getAccount` / `unpackAccount`.
- DON'T trust balance-delta accounting on a confidential-transfer mint; the on-chain amount is encrypted, so refuse to reason about exact amounts.
- DON'T assume a mint is permanent by address alone; a `MintCloseAuthority` mint can be closed and the address reused, so verify on chain.
- DON'T do CPI-based transfers or approvals on an account with CPI guard enabled; they are blocked unless you use the delegation flow.

## Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `TokenAccountNotFoundError` / "could not find account" | Reading or transferring to an ATA that was never created, or it was derived with the wrong token program id | Derive with the detected `programId`, then create the ATA idempotently with `createAssociatedTokenAccountIdempotentInstruction` before depositing |
| "incorrect program id" / `IncorrectProgramId` / wrong ATA address | Used `TOKEN_PROGRAM_ID` for a Token-2022 mint (or the reverse) in derivation, transfer, mint, burn, or close | Detect the mint owner, then pass that program id to every call including `getAssociatedTokenAddressSync` and the ATA instruction |
| "insufficient lamports" / "Transfer: insufficient funds" creating an ATA | Payer cannot cover the about 0.00204 SOL rent-exemption per new token account, or the WSOL wrap exceeds the SOL balance plus fees | Fund the payer; budget about 0.00204 SOL per ATA you create plus the transaction fee, and leave headroom when wrapping SOL |
| "invalid decimals" / decimals mismatch on `transferChecked` | Passed a hardcoded decimals value that does not match the mint | Read `getMint(...).decimals` and pass that exact value; `transferChecked` reverts on a mismatch by design |
| Recipient received less than sent | A Token-2022 transfer-fee mint withholds a fee on transfer | Read `feeBasisPoints` and `maxFee` from the mint, expect `received = amount - fee`, and use the on-chain balance delta as the source of truth |
| Transfer fails with missing accounts on a hook mint | A Token-2022 transfer-hook mint needs the hook program and its `ExtraAccountMetaList` accounts appended | Use a transfer helper that resolves and appends the hook's extra account metas, or resolve them manually. See `resources/token-2022-gotchas.md` |
| "account is non-transferable" | The mint has the non-transferable (soulbound) extension | The token cannot be moved by design; do not attempt a transfer. The holder can only close their account |
| "Non-native account can only be closed if its balance is zero" | Closing a token account that still holds tokens | Transfer out or `burnChecked` the remaining balance first, then close. WSOL is exempt: closing it unwraps any balance to lamports |
| Cannot close / "account not empty" with a zero spendable balance | A Token-2022 fee account still holds withheld transfer fees | Check `getTransferFeeAmount(account).withheldAmount`; if nonzero, `harvestWithheldTokensToMint(connection, payer, mint, [account], undefined, programId)` first, then close |
| Transfer fails right after creating the ATA / "account is frozen" | The Token-2022 mint has `DefaultAccountState` = frozen, so new ATAs are created frozen | Read `getAccount(...).isFrozen` after creation; if frozen, the freeze authority must thaw it before any transfer |
| `TokenOwnerOffCurveError` deriving an ATA | The owner is a PDA (off the ed25519 curve) and `allowOwnerOffCurve` was left `false` | Pass `allowOwnerOffCurve = true` to `getAssociatedTokenAddressSync` when the owner is a program vault or escrow authority |
| Fee mismatch / tx reverts on `transferCheckedWithFee` | The client passed a `fee` that does not equal `min(amount * feeBasisPoints / 10000, maxFee)` | Read `feeBasisPoints` and `maxFee` from `getTransferFeeConfig(mintInfo).newerTransferFee` and compute the exact fee, or use plain `transferChecked` and read the balance delta |
| Transfer reverts with no obvious cause on a Token-2022 mint | The mint is paused (`PausableConfig`), requires a memo (`MemoTransfer` on the destination), or is confidential | Detect the extension and handle it: wait/abort if paused, prepend a memo instruction if required, refuse balance-delta math if confidential. See `resources/token-2022-gotchas.md` |

## References

- `resources/ata-and-programs.md` - program ids, ATA derivation rules, classic-vs-Token-2022 auto-detection, idempotent creation vs `getOrCreateAssociatedTokenAccount`, off-curve PDA ATAs, balance reading, `NATIVE_MINT_2022`, rent numbers.
- `resources/token-2022-gotchas.md` - transfer-fee shortfall and withheld-fee close blocker, transfer-hook extra accounts, non-transferable, default-frozen ATAs, permanent delegate, required memo, pausable, CPI guard, mint close authority, confidential transfer, and the variable-length deserialization rule, each with a one-line detect and handle.
- `examples/transfer-token.ts` - runnable: detect the program, idempotently create the recipient ATA, read decimals, `transferChecked` the right base-unit amount.
- `examples/wrap-unwrap-sol.ts` - runnable: wrap SOL to WSOL (`transfer` + `syncNative`) and unwrap (`closeAccount`).
- [SPL Token program docs](https://spl.solana.com/token)
- [Associated Token Account program](https://spl.solana.com/associated-token-account)
- [@solana/spl-token JS reference](https://solana-labs.github.io/solana-program-library/token/js/)
- [@solana/web3.js docs](https://solana.com/docs/clients/javascript)
