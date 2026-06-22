---
name: solana-spl-token-ops
description: Everyday SPL token and Associated Token Account lifecycle on Solana. Covers SPL token transfers, associated token account (ATA) derivation and idempotent creation, reading mint decimals, transferChecked, minting and burning, wrapping and unwrapping SOL (WSOL), closing accounts to reclaim rent, and auto-detecting whether a mint uses the classic Token program or Token-2022. Load this when a user wants to send a token, create or fund an ATA, wrap or unwrap SOL, convert UI amounts to base units, close a token account, or work with an arbitrary mint without knowing its token program.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana SPL Token Operations

Build and operate the everyday SPL token flows an agent reaches for constantly: send tokens, create the recipient's Associated Token Account (ATA) so the transfer lands, read decimals so amounts are correct, wrap and unwrap SOL, and close empty accounts to get the rent back. This skill is program-aware: it auto-detects whether a mint is owned by the classic Token program or Token-2022 and threads the right program id through every call, which is the single most common source of SPL bugs.

This is the action layer for fungible tokens. For minting tokens with extensions (transfer fees, on-chain metadata, hooks, soulbound), load `token-2022`. For NFTs, load the Metaplex skill. For swaps, load Jupiter.

## Overview

A token "balance" on Solana lives in a token account, not on the wallet itself. The canonical token account for a (wallet, mint) pair is the Associated Token Account, a PDA derived from the owner, the mint, and the token program. Three facts drive almost every operation:

1. There are two token programs. Classic Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`) and Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`). A mint belongs to exactly one of them. ATA derivation, transfers, mints, burns, and closes must all use that mint's program id. Pass the wrong one and you derive a different, unrelated address or send to the wrong program. Detect the program by reading the mint account's `owner`; never assume.

2. Amounts are integers in base units, not UI floats. A token with 6 decimals stores 1.5 tokens as `1500000`. The decimals live on the mint, so read them with `getMint`; never hardcode 9. Prefer `transferChecked` (it takes the mint and decimals and reverts on a mismatch) over the unchecked `transfer`.

3. Accounts cost rent. Creating an ATA for someone costs the payer about 0.00204 SOL of rent-exemption. Closing an empty token account returns that rent to the owner. The destination must already have an ATA, or the transfer fails, so create it (idempotently) first.

Token-2022 mints can also change transfer semantics: a transfer-fee mint delivers less than was sent, a transfer-hook mint requires extra accounts, and a non-transferable mint rejects transfers entirely. Detect these from the mint's extensions and handle them. See `resources/token-2022-gotchas.md`.

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

3. Create the ATA idempotently before depositing into it. Use `createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, programId, ASSOCIATED_TOKEN_PROGRAM_ID)` so a re-run or a race does not throw `TokenAccountNotFoundError` on read or "account already in use" on create. Exit criteria: the recipient ATA exists on chain. The payer funds the rent (about 0.00204 SOL). Prefer this over the non-idempotent `createAssociatedTokenAccountInstruction`, which throws if the ATA already exists.

4. Read decimals from the mint, never hardcode. Call `getMint(connection, mint, commitment, programId)` and use `mintInfo.decimals`. Convert a UI amount to base units carefully:
   ```ts
   const baseUnits = BigInt(Math.round(uiAmount * 10 ** decimals));
   ```
   Exit criteria: the integer you pass to a transfer reflects the mint's real decimals. For amounts where float rounding is unacceptable, parse the string into base units directly instead of multiplying a float.

5. Move tokens with `transferChecked`, not `transfer`. `transferChecked(connection, payer, source, mint, destination, owner, amount, decimals, [], options, programId)` passes the mint and decimals so the program reverts on a decimals or mint mismatch instead of silently moving the wrong amount. Exit criteria: the transaction confirms and the destination balance increased. On a Token-2022 fee mint, the delivered amount is less than `amount`; read the actual balance delta rather than assuming `received == amount`. See `resources/token-2022-gotchas.md`.

6. Wrap SOL into WSOL when a flow needs the native mint as an SPL token. WSOL mint is `So11111111111111111111111111111111111111112` (9 decimals) and uses the classic Token program. Get or idempotently create the WSOL ATA, `SystemProgram.transfer` lamports into it, then `createSyncNativeInstruction(ata, TOKEN_PROGRAM_ID)` to make the token balance reflect the lamports. Exit criteria: the WSOL ATA's token amount equals the wrapped lamports. See `examples/wrap-unwrap-sol.ts`.

7. Unwrap WSOL or close any empty token account to reclaim rent with `createCloseAccountInstruction(account, destination, owner, [], programId)`. For WSOL this returns both the wrapped lamports and the account rent to the destination. For any other mint the token balance must be zero first (transfer or burn the remainder), then close returns the about 0.00204 SOL rent. Exit criteria: the token account no longer exists and the destination received the lamports.

8. Test on devnet first. Airdrop SOL with `connection.requestAirdrop`, run the flow, and verify balances with `getAccount` and `getMint` before doing the same on mainnet with a funded keypair loaded from an env var. Exit criteria: balances and rent reclaim match expectations on devnet.

## Examples

### Send an SPL token to a wallet that may not have an account yet

When the user asks: "Send 25 of this token to that wallet."

The agent should:
1. Detect the mint's program by reading the mint account owner (classic vs Token-2022).
2. Derive the recipient ATA with that program id and create it idempotently (the payer covers the rent).
3. Read decimals with `getMint` and convert 25 to base units (`25 * 10 ** decimals`).
4. Call `transferChecked` with the amount, decimals, and detected program id.
5. If the mint is a Token-2022 fee mint, read the recipient balance delta rather than assuming 25 arrived.

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
2. If the balance is nonzero, transfer the remaining tokens out or `burnChecked` them so the account is empty.
3. `createCloseAccountInstruction(account, destination, owner, [], programId)` to return the about 0.00204 SOL rent to the destination.
4. Confirm the account no longer exists with `getAccountInfo`.

## Guidelines

- DO read the mint account owner to detect classic Token vs Token-2022 before acting on any mint you did not create, and thread that program id through every call.
- DO pass `programId` and `ASSOCIATED_TOKEN_PROGRAM_ID` to `getAssociatedTokenAddressSync` and the ATA creation instruction. The wrong token program derives a different ATA.
- DO use `createAssociatedTokenAccountIdempotentInstruction` as the default; it is safe to re-run and survives races.
- DO read decimals with `getMint` and convert UI amounts to base unit `BigInt`s. Never hardcode 9.
- DO use `transferChecked` (mint + decimals) over `transfer`. It reverts on a decimals or mint mismatch instead of moving the wrong amount.
- DO empty a token account (transfer out or burn) before closing any non-WSOL account; close only works on a zero balance.
- DO read the actual recipient balance delta after a transfer on a possible fee mint. Do not assume `received == amount`.
- DO test on devnet with an airdrop before running on mainnet.
- DON'T mix program ids. Deriving an ATA with the classic id for a Token-2022 mint (or vice versa) produces a wrong, unrelated address and a confusing `TokenAccountNotFoundError`.
- DON'T deposit into or transfer to an ATA without ensuring it exists first; create it idempotently.
- DON'T multiply large UI amounts as JavaScript numbers where precision matters; parse strings into base units to avoid float rounding.
- DON'T close a token account that still holds tokens; the instruction fails until the balance is zero.
- DON'T assume a Token-2022 mint behaves like a plain token; check for transfer fee, transfer hook, and non-transferable extensions. See `resources/token-2022-gotchas.md`.

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

## References

- `resources/ata-and-programs.md` - program ids, ATA derivation rules, classic-vs-Token-2022 auto-detection, idempotent creation, rent numbers.
- `resources/token-2022-gotchas.md` - transfer-fee shortfall, transfer-hook extra accounts, and non-transferable mints, and how to handle each.
- `examples/transfer-token.ts` - runnable: detect the program, idempotently create the recipient ATA, read decimals, `transferChecked` the right base-unit amount.
- `examples/wrap-unwrap-sol.ts` - runnable: wrap SOL to WSOL (`transfer` + `syncNative`) and unwrap (`closeAccount`).
- [SPL Token program docs](https://spl.solana.com/token)
- [Associated Token Account program](https://spl.solana.com/associated-token-account)
- [@solana/spl-token JS reference](https://solana-labs.github.io/solana-program-library/token/js/)
- [@solana/web3.js docs](https://solana.com/docs/clients/javascript)
