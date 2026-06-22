---
name: solana-tx-doctor
description: Diagnose, decode, and recover from Solana transaction failures, and simulate any transaction before signing. Use when a transaction failed, an RPC or simulation returned an opaque error object, you see a slippage or DEX custom error ("custom program error: 0x1771", Custom 6001, Jupiter/Raydium/Orca/pump.fun/Meteora swap revert), any Anchor custom error (Anchor 6xxx) or framework code (Constraint 2xxx, Account 3xxx), a TransactionError variant (BlockhashNotFound, InsufficientFundsForRent, InsufficientFundsForFee, AccountInUse, TooManyAccountLocks, AddressLookupTableNotFound, AlreadyProcessed), a dropped vs reverted question, a compute-budget-exceeded failure, a CPI failure deep in the stack, or you need to decide go/no-go before sending. Keywords: transaction failed, slippage exceeded, 0x1771, decode error, custom program error, Anchor 6xxx, simulation failed, blockhash expired, dropped transaction, compute budget exceeded, CPI failed, Token-2022 transfer hook, debug Solana transaction, why did my tx revert.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Transaction Doctor

Turn an opaque Solana transaction failure into a named cause, the exact failing instruction and program, and a concrete next action, then never sign blind again thanks to a simulate-before-sign gate.

## Overview

A failed Solana transaction in production almost never says why. You get a bare `{ InstructionError: [1, { Custom: 6001 }] }`, a `"BlockhashNotFound"`, or a log wall ending in `custom program error: 0x1771`, and the agent stalls: it either retries a transaction that already reverted (burning fees, sometimes replaying an effect) or gives up on one it could have recovered. Protocol integration skills teach an agent to build the call; this one teaches it to read the wreckage when the call comes back broken and to act safely on what it reads.

The procedure is the same four steps every time: **classify -> decode -> locate -> remediate**. A fifth path, **simulate-before-sign**, runs the same machinery on an unsigned transaction so a failure is caught before it costs a lamport.

Use this skill when you have any of these three inputs:
1. A failed transaction **signature** (you can fetch it from RPC).
2. A raw **error object** from an RPC `sendTransaction` / `simulateTransaction` call, or a caught SDK error.
3. An **unsigned transaction** you are about to send and want to vet first.

This skill is read-only diagnosis and simulation. It never blind-resends. It complements source-bug skills (`vulnhunter`, `zz-code-recon`) and holdings skills (`wallet-analysis`): those find bugs in code or report balances; this one explains a live runtime failure.

## Slippage first: the 0x1771 default hypothesis

Helius post-mortems report that **over 80% of failed Solana transactions are `0x1771` (decimal 6001), which means "exceeded desired slippage."** If a swap failed, slippage is the most likely cause by a wide margin, so make it your first hypothesis before anything more exotic.

`0x1771` is hex; convert it: `parseInt("0x1771", 16) === 6001`. It is the second entry of an Anchor `#[error_code]` enum (which starts at 6000), which is why so many DEX programs land on exactly this number for their slippage check. Confirm the meaning against the SPECIFIC program that reverted, because the same number is a different error in a different program.

A slippage failure **landed and reverted**: the fee was burned and the swap did not happen. It is NOT safe to blind-retry. The fix is always the same shape: do not resend the same bytes, refresh the quote (the old one is stale, that is why it reverted), widen tolerance (raise `slippageBps`; for pump.fun raise `max_sol_cost` or lower `min_sol_output`), rebuild on a fresh blockhash, and optionally add a priority fee so the fresh quote lands in time.

The per-program slippage and swap error codes for Jupiter, Raydium, Orca, pump.fun, and Meteora are in `resources/dex-error-codes.md`. Identify the failing program from the CPI stack, then look the code up in THAT program's IDL or that table.

## Instructions

Run the steps in order. Each has an exit condition. Stop early when the class is already fully resolved (a `BlockhashNotFound` needs no instruction-level decode).

### Step 0: Identify the input

- If you have a **signature** string, go to Step 1.
- If you have a **raw error object** (from a caught exception, `simulateTransaction().value.err`, or an RPC response), skip fetching and go straight to Step 2 with `err` and `logs` in hand.
- If you have an **unsigned transaction**, go to the Simulate-Before-Sign section. Run Steps 2 through 4 on the simulation result.

**Success criterion:** You know which of the three inputs you have and where the `err` and `logs` will come from.

### Step 1: Fetch the failed transaction

Pull the on-chain record. Use `maxSupportedTransactionVersion: 0` or `getTransaction` rejects versioned (v0) transactions.

```ts
const tx = await connection.getTransaction(signature, {
  maxSupportedTransactionVersion: 0,
});
```

- If `tx === null`: the signature is not on chain. It was **dropped** (never landed) or you are querying too early or on the wrong cluster. Confirm with `getSignatureStatuses([signature], { searchTransactionHistory: true })`. A `null` status after the slot's `lastValidBlockHeight` has passed means dropped: this is the **blockhash-expired / dropped** class. Go to Step 4 with that class. Do NOT keep polling forever.
- If `tx.meta.err === null`: the transaction **succeeded**. There is nothing to diagnose. Report success and stop.
- Otherwise capture `err = tx.meta.err` and `logs = tx.meta.logMessages`. Go to Step 2.

**Success criterion:** You have `err` (a `TransactionError`) and `logs` (the program log array), or you have classified the tx as dropped/succeeded.

### Step 1b: Dropped vs reverted (the detection that prevents fund-loss bugs)

This is a named decision because confusing the two states is the most expensive mistake an agent makes. They demand opposite actions.

- **DROPPED (never executed):** `getSignatureStatuses([sig], { searchTransactionHistory: true })` returns a `null` status AND current block height has passed `lastValidBlockHeight`. Nothing landed, no fee was charged, there is no on-chain record. It is **safe to rebuild and resend** with a fresh blockhash. A `null` status while height is still below `lastValidBlockHeight` is NOT dropped: it is in flight, so wait, do not resend.
- **REVERTED (executed then failed):** `getTransaction` returns a record with `meta.err !== null`. It landed, the fee was burned, the logic failed. It is **final**. Do NOT blindly resend: the signature already exists on chain, resending the same bytes does nothing useful, and rebuilding-and-resending can re-run an unintended effect. Fix the cause, then send a NEW transaction only if the operation genuinely did not happen.

**Idempotency safety line: if a record exists, it already landed, do not resend.** Resend ONLY a transaction you have positively confirmed is DROPPED by the two-part test above. When in doubt, treat it as landed and do not resend.

The decision in one line: `status === null && height > lastValidBlockHeight` means DROPPED (rebuild + resend on a fresh blockhash); a fetched record with `meta.err` means REVERTED (final, fix the cause, never blind-resend).

**Success criterion:** Every transaction is labeled DROPPED or REVERTED before any resend is considered.

### Step 2: Classify the failure

Map `err` to exactly one class. See `resources/error-classes.md` for the full taxonomy and variant table. The decision tree:

1. `err` is the string `"BlockhashNotFound"` or `"AlreadyProcessed"`, or the tx was not found at all -> **dropped / blockhash-expired** (the transaction never executed).
2. `err` is an object `{ InsufficientFundsForRent: { account_index } }` -> **rent** class.
3. `err` is an object `{ InstructionError: [index, detail] }` -> a per-instruction failure. Read `detail`:
   - `detail === { Custom: N }` and `N >= 6000` -> **Anchor custom error** class. **If the failing program is a DEX and `N` is `6001` (`0x1771`), default to the slippage hypothesis** (see the dedicated section below): over 80% of failed Solana transactions are this. Confirm against the program's IDL or `resources/dex-error-codes.md`.
   - `detail === { Custom: N }` and `N < 6000` -> **native / built-in program error** class (often SPL Token, e.g. `0x1 = 1` insufficient funds). Resolve against the program that reverted using `resources/native-program-errors.md`.
   - `detail` is a string like `"PrivilegeEscalation"`, `"ProgramFailedToComplete"`, `"ComputeBudgetExceeded"` -> **raw InstructionError variant** class. `"ComputeBudgetExceeded"` is the **compute-budget** class specifically.
4. `err` is any other bare string or object with no `InstructionError` (e.g. `"AccountNotFound"`, `"AccountInUse"`, `"SignatureFailure"`, `"TooManyAccountLocks"`, `"AddressLookupTableNotFound"`, `{ DuplicateInstruction: i }`, `{ ProgramExecutionTemporarilyRestricted: { account_index } }`, `"UnbalancedTransaction"`) -> **transaction-level error** class. See the full enum in `resources/error-classes.md`.

Record `instructionIndex = err.InstructionError?.[0]` when present: you need it in Step 3.

**Success criterion:** Exactly one class is assigned, and (for instruction errors) you have the failing top-level instruction index.

### Step 3: Decode the cause

The goal is a human-readable name and message. See `resources/decode-reference.md` for every decode path. Orchestrate the OFFICIAL primitives so the doctor never falls behind upstream:

- `@solana/errors`: `getSolanaErrorFromTransactionError(err)` and `getSolanaErrorFromInstructionError(index, detail)` decode the raw RPC `TransactionError` / `InstructionError` shapes into typed `SolanaError` objects (the framework and runtime variants). `isSolanaError(e)` is the type guard. CLI: `npx @solana/errors decode <code>`.
- `@solana-developers/helpers`: `decodeAnchorTransaction(connection, signature)` auto-fetches each program's IDL by program id and decodes the instruction names, args, and accounts. `getSimulationComputeUnits(connection, instructions, payer, lookupTables?)` returns the consumed CU for sizing the budget.
- These cover everything except your program's own `Custom: >= 6000` codes, which you still resolve against the IDL `errors` array (path 3 below). Keep the offline registry GENERATED from `@solana/errors` plus on-chain IDLs, not hand-maintained, so it never drifts. `examples/decode-with-official-primitives.ts` runs this.

Order of attempts:

1. **Parse the logs first.** Anchor already prints the answer in most cases:
   `Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: ...`. Native programs and `require!`-style checks also log human strings. If a decoded `Error Code`/`Error Message` line exists, you are done: use it.
2. **Normalize hex and decimal.** A log line `custom program error: 0x1771` carries the code in hex; `meta.err` and IDLs use decimal. Convert on sight: `parseInt("0x1771", 16) === 6001`. Then route by range: `< 100` native, `100..5999` Anchor framework-reserved, `>= 6000` the program's own IDL.
3. **IDL lookup by code (Anchor custom, code >= 6000, with the 6000 base).** Load the failing program's IDL (`Program.fetchIdl(programId, provider)` from the on-chain IDL account, `decodeAnchorTransaction`, or a bundled copy). The enum index is `code - 6000`, but the IDL stores the absolute code: `idl.errors.find(e => e.code === N)` -> `{ code, name, msg }`. Report `name` and `msg`.
4. **Anchor framework-reserved ranges (code >= 100 and < 6000).** These are built-in Anchor errors, not your program's, so they are NOT in your IDL `errors` array. Resolve the range to a meaning: Instruction 100-999, IDL 1000-1999, Constraint 2000-2999 (`2001 ConstraintHasOne`, `2006 ConstraintSeeds`), Account 3000-3999 (`3007 AccountOwnedByWrongProgram`, `3012 AccountNotInitialized`), `4100 DeclaredProgramIdMismatch`, deprecated/misc 5000-5999. See the full range table in `resources/decode-reference.md` and `resources/error-classes.md`.
5. **Native code (code < 100, or string InstructionError variant).** Resolve against the offending program using `resources/native-program-errors.md` (System, Associated Token, Token-2022 extensions, Compute Budget, Address Lookup Table, Stake, Vote). For classic SPL Token use the `TokenError` mapping (`1 = InsufficientFunds`, `4 = OwnerMismatch`). For SDK / system-level errors use `@solana/errors`.
6. **Third-party fallback (generated registry).** If the code belongs to a program whose IDL you cannot fetch, resolve against an offline registry GENERATED from on-chain IDLs (the community `tenequm/solana-idls` bundle, ~1,914 error defs across 41 protocols, is a snapshot to regenerate from) keyed by `(programId, code)`. If still unknown, report the raw code and the program id and say it is unresolved rather than guessing.

**Success criterion:** You have a named error (or an explicit "unresolved code N from program P") plus a one-line meaning.

### Step 4: Locate the failing instruction and program

Attribute the failure precisely so the remediation targets the right call.

- The **top-level instruction** is `instructionIndex` from Step 2. Map it to the message's instruction list to get the program invoked.
- The **actual failing program** may be a CPI inner program. Reconstruct the call stack from the logs. Each `Program <ID> invoke [depth]` pushes a frame; `Program <ID> success` pops it; `Program <ID> failed: <reason>` marks the frame where the failure originated. The deepest frame still open at the failure line is the program that actually reverted, even though `InstructionError[0]` points at the top-level instruction that contained the CPI.

```
Program JUP... invoke [1]        <- top-level instruction 1
  Program whirL... invoke [2]    <- CPI into Orca
  Program whirL... failed: custom program error: 0x1771   <- failure originates here (6001)
Program JUP... failed: ...
```

So a `Custom: 6001` on instruction index 1 is the AMM's slippage error, not Jupiter's.

For a precise attribution, do three things (full procedure in `resources/decode-reference.md` Path 8, runnable in `examples/cpi-stack-trace.ts`):
1. Reconstruct the stack from the logs; the deepest frame open at the first `failed` is the program that reverted.
2. **Align to `innerInstructions`** from `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` (or `simulateTransaction(..., { innerInstructions: true })`) to confirm the log reading against on-chain structure.
3. **Resolve account roles through Address Lookup Tables** for v0 transactions: fetch each table in `message.addressTableLookups` with `connection.getAddressLookupTable(...)`, then `message.getAccountKeys({ addressLookupTableAccounts })` maps every index to a pubkey.

Then output an **indented tree plus a verdict**, for example: `failing program = X at depth 2, called by top-level ix #1`.

**Success criterion:** You can name (a) the top-level instruction index, (b) the program that actually reverted and its depth, and (c) for rent/funds errors, the account index involved, plus an indented CPI tree and a one-line verdict.

### Step 5: Remediate

Map the class to a concrete next action. See the full remediation map in `resources/error-classes.md`. Summary:

| Class | Safe to retry as-is? | Action |
|-------|----------------------|--------|
| dropped / blockhash-expired | YES (it never executed) | Rebuild with a fresh blockhash, re-sign, resend. |
| compute-budget-exceeded | After fixing | Add/raise `ComputeBudgetProgram.setComputeUnitLimit` to simulated `unitsConsumed` plus ~10-20% margin. |
| rent (InsufficientFundsForRent) | After funding | Fund the account; a token account needs ~0.00204 SOL rent-exemption. |
| Anchor custom (slippage, etc.) | NO | Surface decoded reason. Fix the input (raise slippage, refresh quote, correct amount), do not blind-retry. |
| native / built-in (SPL Token etc.) | NO | Surface decoded reason (insufficient balance, wrong owner, wrong token program). Correct the instruction. |
| raw TransactionError variant | Depends (see table) | Resolve per variant: `AccountNotFound` -> create/fund account; `PrivilegeEscalation` -> fix signer/writable flags. |

**Critical safety rule:** Only retry transactions that were **dropped and never landed**. NEVER blind-retry a transaction that **reverted** (it can re-run a partially intended effect or burn fees in a loop). A confirmed-but-`err` transaction is **final**: treat it as done, never retry it. Never re-sign and resend after `lastValidBlockHeight` has passed without first fetching a fresh blockhash.

**Success criterion:** You output a structured diagnosis: class, decoded name + message, failing program + instruction index, and the exact corrected next action (with a clear retry/no-retry verdict).

### Simulate-Before-Sign (preventive path)

Run this on an **unsigned** transaction before it is ever signed. Harden the simulation with three flags: `sigVerify: false` (it is not signed), `replaceRecentBlockhash: true` (ignore a stale/missing blockhash for the dry run), and `innerInstructions: true` (so the CPI structure comes back for attribution).

```ts
const sim = await connection.simulateTransaction(tx, {
  sigVerify: false,             // tx is not signed yet
  replaceRecentBlockhash: true, // ignore a stale/missing blockhash for the dry run
  innerInstructions: true,      // return inner instructions for CPI attribution
});
```

`sim.value` returns `{ err, logs, unitsConsumed, accounts, returnData, innerInstructions }`. Then:

1. If `sim.value.err !== null`, feed `err` and `logs` into Steps 2 through 4 above (use `innerInstructions` for the CPI attribution) and return **no-go** with the decoded reason.
2. If `err === null`, report `unitsConsumed`, the programs touched (from `invoke` log lines), the writable accounts, and (if requested) pre/post SOL and token balance deltas computed from `accounts`. Return **go**.
3. **Pre-empt ComputeBudgetExceeded.** Read `unitsConsumed` to size the limit before signing. The cleanest path is `getSimulationComputeUnits(connection, instructions, payer, lookupTables?)` from `@solana-developers/helpers`, then prepend `ComputeBudgetProgram.setComputeUnitLimit(Math.ceil(units * 1.1))` (a bit of headroom). This prevents the compute-budget class entirely. Cap awareness: the per-transaction limit is 1,400,000 CU; if you need more, split the transaction.

**Success criterion:** A go/no-go verdict with `unitsConsumed`, a recommended CU limit, programs touched, and (on no-go) the same structured diagnosis as the post-mortem path.

## Examples

### Example 1: Anchor 6xxx slippage failure, decoded end to end from a signature

User input: "My swap failed, here is the signature `5xq...abc`, why?"

The agent runs the procedure:

1. **Fetch** with `getTransaction(sig, { maxSupportedTransactionVersion: 0 })`. `meta.err` is `{ InstructionError: [1, { Custom: 6001 }] }`, `meta.logMessages` present.
2. **Classify:** object with `InstructionError`, `detail = { Custom: 6001 }`, `6001 >= 6000` -> **Anchor custom error**. `instructionIndex = 1`.
3. **Decode (logs first):** a log line reads `Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: Exceeded max slippage tolerance.` Done: name `SlippageExceeded`, message as logged. (If that line were absent, the agent would `fetchIdl` the inner program and look up `errors.find(e => e.code === 6001)`.)
4. **Locate:** the CPI-stack parser walks the `invoke [depth]` / `failed` lines. Top-level instruction 1 is the swap aggregator; the open frame at the failure is the Orca whirlpool program. So `6001` is the AMM's slippage check, not the aggregator's.
5. **Remediate:** class is Anchor custom -> NOT safe to blind-retry. The price moved past tolerance. Corrected action: refresh the quote and either raise `slippageBps` or reduce size, then build a new transaction.

Structured output:

```
DIAGNOSIS
  class:        anchor-custom-error
  error:        SlippageExceeded (6001)
  message:      Exceeded max slippage tolerance.
  reverted in:  whirL... (Orca), via top-level instruction #1 (aggregator CPI)
  retry as-is:  NO (reverted on chain, final)
  fix:          re-quote, raise slippageBps or lower amount, rebuild + resend
```

`examples/diagnose-signature.ts` runs exactly this flow against any signature.

### Example 2: Blockhash-expired dropped transaction, safe-retry remediation

User input: "I sent a transfer, got a signature back, but it never confirmed."

1. **Fetch:** `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` returns `null`.
2. **Confirm dropped:** `getSignatureStatuses([sig], { searchTransactionHistory: true })` returns `value: [null]`, and the current block height is past the transaction's `lastValidBlockHeight`.
3. **Classify:** not on chain, expired -> **dropped / blockhash-expired**. The transaction **never executed**.
4. **Locate:** not applicable; nothing ran.
5. **Remediate:** this is the one class that is **safe to retry**. Rebuild with a fresh blockhash, re-sign, resend.

```ts
const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
tx.message.recentBlockhash = blockhash; // or rebuild the message for v0
tx.sign([payer]);
const newSig = await connection.sendRawTransaction(tx.serialize());
await connection.confirmTransaction({ signature: newSig, blockhash, lastValidBlockHeight });
```

Structured output:

```
DIAGNOSIS
  class:        dropped / blockhash-expired
  error:        transaction never landed (expired before inclusion)
  retry as-is:  YES (it never executed, no on-chain effect)
  fix:          fetch fresh blockhash, re-sign, resend, confirm against lastValidBlockHeight
```

### Example 3: Simulate before signing

User input: "Here is an unsigned VersionedTransaction, is it safe to send?"

The agent runs `examples/simulate-before-sign.ts`: `simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, innerInstructions: true })`. On `err === null` it reports `unitsConsumed: 41320`, programs touched `[System, Token, whirL...]`, payer SOL delta `-0.002 SOL`, and verdict **GO**, plus a recommended `setComputeUnitLimit(47518)`. On any `err` it returns **NO-GO** with the decoded reason from Steps 2 to 4, before a single lamport is spent.

### Example 4: More worked cases

`examples/golden-cases.md` carries seven concise end-to-end diagnoses as copy-ready templates: a Jupiter `0x1771` slippage failure, an Anchor `6001` resolved via the IDL `errors` array, a `ComputeBudgetExceeded` with the exact CU fix, an `InsufficientFundsForRent` with the exact lamports to top up, a Token-2022 transfer-hook CPI failure two levels deep, a blockhash-expired dropped transaction (safe to resend), and a versioned transaction using Address Lookup Tables.

## Guidelines

- **DO** label every transaction DROPPED or REVERTED before considering a resend. Only DROPPED (null status past `lastValidBlockHeight`) is safe to resend; a fetched record means it landed, so do not resend it.
- **DO** make slippage your first hypothesis for a failed swap. `0x1771` (6001) on a DEX is the >80% case; confirm it against the failing program's IDL or `resources/dex-error-codes.md`.
- **DO** orchestrate the official primitives (`@solana/errors`, `decodeAnchorTransaction`, `getSimulationComputeUnits`) before hand-parsing, and keep any offline registry generated from them so it never drifts.
- **DO** classify before decoding. The class decides whether you even need an instruction-level decode and whether a retry is ever safe.
- **DO** parse the program logs before reaching for the IDL. Anchor and most programs already log the decoded error; the IDL lookup is the fallback, not the first move.
- **DO** convert hex codes from logs (`0x1771`) to decimal before resolving them.
- **DO** attribute failures to the inner CPI program using the `invoke [depth]` stack, not to the top-level program by default.
- **DO** simulate with `sigVerify: false` and `replaceRecentBlockhash: true` for unsigned transactions, and set the compute limit from the simulated `unitsConsumed`.
- **DON'T** blind-retry a reverted transaction. Only dropped (never-landed) transactions are safe to resend.
- **DON'T** treat a confirmed-but-`err` transaction as retryable. It is final.
- **DON'T** resend after `lastValidBlockHeight` has passed without a fresh blockhash.
- **DON'T** guess an unresolved code's meaning. Report the raw code and program id and say it is unresolved.
- **DON'T** forget `maxSupportedTransactionVersion: 0` on `getTransaction`, or v0 transactions return `null` and look falsely dropped.

## Common Errors

A causes-and-solutions table for the main `TransactionError` shapes. Full taxonomy in `resources/error-classes.md`.

| `err` value | Class | Cause | Solution | Retry as-is |
|-------------|-------|-------|----------|-------------|
| `"BlockhashNotFound"` | dropped | Blockhash too old/unknown by inclusion time; tx never executed. | Fresh blockhash, re-sign, resend. | YES |
| `null` tx + expired height | dropped | Transaction dropped from mempool, never landed. | Fresh blockhash, re-sign, resend, confirm. | YES |
| `"AlreadyProcessed"` | dropped (no-op) | Same blockhash+signature already seen; nothing new executed. | Use a fresh blockhash if you actually need a new tx. | YES (with fresh blockhash) |
| `{ InstructionError: [i, { Custom: N }] }`, N >= 6000 | anchor-custom | Program asserted a check (slippage, deadline, auth). | Decode via logs/IDL, fix the input, rebuild. | NO |
| `{ InstructionError: [i, { Custom: N }] }`, N < 6000 | native | Built-in program error (e.g. SPL Token `1` = insufficient funds, `4` = owner mismatch). | Decode via TokenError/program mapping, correct the instruction. | NO |
| `{ InstructionError: [i, "ComputeBudgetExceeded"] }` | compute-budget | Instruction used more CU than the limit. | Add `setComputeUnitLimit` from simulated `unitsConsumed` + margin. | After fix |
| `{ InstructionError: [i, "PrivilegeEscalation"] }` | raw variant | An account needed signer/writable it was not granted. | Fix signer list and writable flags on the instruction. | After fix |
| `{ InstructionError: [i, "ProgramFailedToComplete"] }` | raw variant | Program panicked or hit a runtime limit (often CU or a `panic!`). | Simulate to read the panic log; raise CU or fix inputs. | After fix |
| `{ InsufficientFundsForRent: { account_index } }` | rent | A created account was not funded to rent-exemption. | Fund it (token account ~0.00204 SOL). | After fund |
| `"AccountNotFound"` | tx-level | A referenced account does not exist. | Create/fund the account or fix the address. | After fix |
| `"AccountInUse"` / `"AccountLoadedTwice"` | tx-level | Same writable account locked twice or by another tx. | Deduplicate accounts; retry only if it was a transient lock. | Maybe |
| `"SignatureFailure"` / `"MissingSignature"` | tx-level | Required signer missing or signature invalid. | Add the missing signer and re-sign. | After fix |

### Error: tx fetched as `null` but it actually succeeded
**Cause:** Missing `maxSupportedTransactionVersion: 0`, so `getTransaction` refuses the v0 tx and returns `null`, which looks like a drop.
**Solution:** Always pass `{ maxSupportedTransactionVersion: 0 }`. Confirm with `getSignatureStatuses` before declaring a drop.

### Error: decoded the wrong program's error
**Cause:** Attributing `Custom: N` to the top-level program instead of the CPI inner program.
**Solution:** Reconstruct the `invoke [depth]` stack; the deepest open frame at the `failed` line is the program that reverted.

### Error: retried a reverted tx and it executed a partial effect / burned fees
**Cause:** Blind retry of a transaction that landed with `meta.err`.
**Solution:** Only retry dropped (never-landed) transactions. A landed `err` tx is final.

## References

- `resources/error-classes.md` - dropped-vs-reverted detection, the full `TransactionError` enum, the full `InstructionError` variant map, the classification taxonomy, the per-class remediation playbook (with exact rent lamports), and the security rules.
- `resources/decode-reference.md` - hex/decimal normalization, the 6000 base and Anchor framework-reserved ranges, the IDL `errors`-array lookup, the official-primitives orchestration (`@solana/errors`, `decodeAnchorTransaction`, `getSimulationComputeUnits`), the generated registry, and CPI-stack reconstruction with ALT resolution.
- `resources/dex-error-codes.md` - the slippage / `0x1771` family: per-program swap error codes for Jupiter, Raydium, Orca, pump.fun, and Meteora, plus the one slippage remediation.
- `resources/native-program-errors.md` - error tables for System, Associated Token, Token-2022 (extension errors), Compute Budget, Address Lookup Table, Stake, and Vote.
- `examples/diagnose-signature.ts` - fetch, classify, decode (logs first, IDL fallback), CPI-stack locate, structured diagnosis with remediation. Runnable with `@solana/web3.js`.
- `examples/decode-with-official-primitives.ts` - decode via `@solana/errors` (`getSolanaErrorFromTransactionError` / `getSolanaErrorFromInstructionError` / `isSolanaError`) and `@solana-developers/helpers` `decodeAnchorTransaction`.
- `examples/cpi-stack-trace.ts` - reconstruct the CPI stack from logs, align to `meta.innerInstructions`, resolve account roles through Address Lookup Tables, and print the tree plus a verdict.
- `examples/simulate-before-sign.ts` - simulate an unsigned `VersionedTransaction`, report `unitsConsumed`, programs touched, balance deltas, and a go/no-go.
- `examples/golden-cases.md` - seven worked diagnoses (Jupiter slippage, Anchor 6001 via IDL, ComputeBudgetExceeded, InsufficientFundsForRent, a Token-2022 transfer-hook CPI two levels deep, a dropped blockhash-expired tx, and a v0 transaction using ALTs).
- Solana `getTransaction` RPC: https://solana.com/docs/rpc/http/gettransaction
- Solana `simulateTransaction` RPC: https://solana.com/docs/rpc/http/simulatetransaction
- Solana `getAddressLookupTable` RPC: https://solana.com/docs/rpc/http/getaddresslookuptable
- `TransactionError` enum (agave): https://github.com/anza-xyz/agave/blob/master/sdk/transaction-error/src/lib.rs
- Anchor error reference: https://www.anchor-lang.com/docs/errors
- `@solana/errors` package: https://github.com/anza-xyz/kit/tree/main/packages/errors
- `@solana-developers/helpers`: https://github.com/solana-developers/helpers
- Community error/IDL registry: https://github.com/tenequm/solana-idls
