# Golden Cases

Seven worked diagnoses, each running the same procedure (classify -> decode -> locate -> remediate, or simulate-before-sign). Each shows the input, the reasoning, and the structured output. Use them as templates.

## Case 1: Jupiter 0x1771 slippage failure

**Input:** signature of a failed swap; `meta.err === { InstructionError: [2, { Custom: 6001 }] }`; logs include `Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 invoke [1]` then `... failed: custom program error: 0x1771`.

**Reason:** `0x1771` -> decimal `6001`. Code `>= 6000` so it is the program's own error. The failing program from the CPI stack is Jupiter (`JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`), and `6001` there is `SlippageToleranceExceeded` (see `resources/dex-error-codes.md`). This is the >80% case: the price moved past the min-out from the quote. It LANDED and REVERTED.

```
DIAGNOSIS
  class:        anchor-custom-error (DEX slippage)
  error:        SlippageToleranceExceeded (6001 = 0x1771)
  reverted in:  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4, top-level ix #2
  retry as-is:  NO (reverted on chain, fees burned, final)
  fix:          refresh the quote, raise slippageBps, rebuild on a fresh blockhash, optionally add a priority fee
```

## Case 2: Anchor 6001 resolved via IDL lookup (no decoded log line)

**Input:** signature from a custom Anchor program; `meta.err === { InstructionError: [0, { Custom: 6001 }] }`; logs end in `custom program error: 0x1771` but carry NO `AnchorError occurred ...` line (older program or truncated logs).

**Reason:** logs-first fails (no decoded line). Convert `0x1771` -> `6001`. Code `>= 6000`, so look it up in the program's IDL `errors` array with the 6000 base. `Program.fetchIdl(programId, provider)` (or `decodeAnchorTransaction`) returns the IDL; `idl.errors.find(e => e.code === 6001)` gives `{ code: 6001, name: "InvalidVaultState", msg: "Vault is not in the expected state" }`.

```
DIAGNOSIS
  class:        anchor-custom-error
  error:        InvalidVaultState (6001), resolved from IDL errors array
  message:      Vault is not in the expected state
  reverted in:  <programId>, top-level ix #0
  retry as-is:  NO (reverted, final)
  fix:          correct the precondition the program asserted (state/order of operations), rebuild
```

## Case 3: ComputeBudgetExceeded with the CU fix

**Input:** `meta.err === { InstructionError: [0, "ComputeBudgetExceeded"] }`; logs show `Program ... consumed 200000 of 200000 compute units` then `failed`.

**Reason:** string variant `ComputeBudgetExceeded` -> compute-budget class. The instruction hit the 200,000 CU default. Simulate to read the real consumption: `getSimulationComputeUnits(connection, instructions, payer)` returns, say, `285_400`.

```
DIAGNOSIS
  class:        compute-budget-exceeded
  error:        ComputeBudgetExceeded (used 200000 of 200000)
  reverted in:  top-level ix #0
  retry as-is:  AFTER FIX
  fix:          prepend ComputeBudgetProgram.setComputeUnitLimit(Math.ceil(285400 * 1.15)) = 328210, then rebuild
```

The fix instruction (real API):

```ts
import { ComputeBudgetProgram } from "@solana/web3.js";
const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 328210 });
// prepend cuIx as instruction #0, then re-sign and send.
```

## Case 4: InsufficientFundsForRent with the exact top-up

**Input:** `meta.err === { InsufficientFundsForRent: { account_index: 3 } }`.

**Reason:** rent class. The account at index 3 was created without enough lamports for rent-exemption. Compute the exact amount for its data length. A standard SPL token account is 165 bytes: `connection.getMinimumBalanceForRentExemption(165)` returns `2_039_280` lamports (~0.00203928 SOL).

```
DIAGNOSIS
  class:        rent (InsufficientFundsForRent)
  account idx:  3 (a token account, 165 bytes)
  reverted in:  account creation
  retry as-is:  AFTER FUND
  fix:          fund account #3 with at least 2,039,280 lamports (~0.00203928 SOL), then rebuild
```

Always report the exact lamports, read live with `getMinimumBalanceForRentExemption(dataLen)` for the real size.

## Case 5: CPI failure two levels deep (Token-2022 transfer hook)

**Input:** `meta.err === { InstructionError: [1, { Custom: 6001 }] }`. Logs:

```
Program JUP6Lkb... invoke [1]
  Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb invoke [2]
    Program HookProg1111... invoke [3]
    Program HookProg1111... failed: custom program error: 0x1771
  Program TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb failed: ...
Program JUP6Lkb... failed: ...
```

**Reason:** the top-level index is 1 (Jupiter), but the CPI stack shows the deepest open frame at the first `failed` is `HookProg1111...` at depth 3. The mint uses the Token-2022 TransferHook extension; Token-2022 (depth 2) invoked the hook (depth 3), and the hook reverted with `6001`. Resolve `6001` against the hook program's IDL, not Jupiter's and not Token-2022's. `meta.innerInstructions[1]` confirms the inner programs, and the account roles resolve through the ALTs (see `cpi-stack-trace.ts`).

```
CPI STACK
Program JUP6Lkb... invoke [1]
  Program TokenzQd... invoke [2]
    Program HookProg1111... invoke [3]  FAILED: custom program error: 0x1771

VERDICT
  failing program = HookProg1111... at depth 3 (Token-2022 transfer hook),
  called by Token-2022 (depth 2), under top-level instruction #1 (Jupiter route)
  retry as-is: NO (reverted, final)
  fix: include the hook program and its ExtraAccountMetaList accounts in the transfer,
       or resolve 6001 in the hook's IDL if it is a real precondition; rebuild
```

## Case 6: Blockhash-expired dropped transaction (safe to resend)

**Input:** "I got a signature but it never confirmed."

**Reason:** `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` returns `null`. `getSignatureStatuses([sig], { searchTransactionHistory: true })` returns `value: [null]`, and current block height is past `lastValidBlockHeight`. Two-part test passes: DROPPED, never executed. This is the ONLY class that is safe to resend.

```
DIAGNOSIS
  class:        dropped / blockhash-expired
  error:        transaction never landed (expired before inclusion)
  retry as-is:  YES (never executed, no on-chain effect, no fee burned)
  fix:          fetch a fresh blockhash, re-sign, resend, confirm against the new lastValidBlockHeight
```

Idempotency check first: confirm the status really is `null` (not a landed record) before resending. If `getTransaction` returns ANY record, it already landed; do not resend.

## Case 7: Versioned (v0) transaction using Address Lookup Tables

**Input:** a v0 transaction that fails to fetch or whose accounts cannot be named; or `meta.err === "InvalidAddressLookupTableIndex"`.

**Reason:** v0 transactions carry only `staticAccountKeys` plus references into Address Lookup Tables. If `getTransaction` is called without `maxSupportedTransactionVersion: 0`, it returns `null` and the tx looks falsely dropped, so always pass it. To name the accounts, resolve the lookups: read `message.addressTableLookups`, fetch each table with `connection.getAddressLookupTable(accountKey)`, then call `message.getAccountKeys({ addressLookupTableAccounts })`. An `InvalidAddressLookupTableIndex` means the table changed after the message was built (a lookup index points past its current length); refetch the table and rebuild the v0 message.

```
DIAGNOSIS
  class:        transaction-level (ALT)
  error:        InvalidAddressLookupTableIndex (or accounts unresolved without ALT fetch)
  cause:        lookup index out of range, or getTransaction called without maxSupportedTransactionVersion: 0
  retry as-is:  AFTER FIX
  fix:          refetch the lookup table(s), resolve keys via getAccountKeys({ addressLookupTableAccounts }),
                rebuild the v0 message on a fresh blockhash, resend
```

The full resolution is in `cpi-stack-trace.ts` (`resolveAccountKeys`).

## How these map to the runnable examples

- Cases 1, 2, 3, 4, 6: `diagnose-signature.ts` (fetch, classify, decode, locate, remediate).
- Cases 2, 5: `decode-with-official-primitives.ts` (official `@solana/errors` + `decodeAnchorTransaction`).
- Cases 5, 7: `cpi-stack-trace.ts` (CPI stack + innerInstructions + ALT resolution).
- Pre-sign vetting for any of these: `simulate-before-sign.ts`.
