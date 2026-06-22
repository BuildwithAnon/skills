---
name: solana-tx-doctor
description: Diagnose, decode, and recover from Solana transaction failures, and simulate any transaction before signing. Use when a transaction failed, an RPC or simulation returned an opaque error object, you see a custom program error (Custom 6001, Anchor 6xxx, "custom program error: 0x1771"), a TransactionError variant (BlockhashNotFound, InsufficientFundsForRent, AccountNotFound, AlreadyProcessed), a dropped or expired transaction, a compute-budget-exceeded failure, or you need to decide go/no-go before sending. Keywords: transaction failed, decode error, custom program error, Anchor 6xxx, simulation failed, blockhash expired, debug Solana transaction, why did my tx revert.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Transaction Doctor

A structured procedure for turning an opaque Solana transaction failure into a named cause, the exact failing instruction and program, and a concrete remediation, plus a simulate-before-sign gate so the agent never signs a transaction it has not first checked.

## Overview

Every agent that sends Solana transactions eventually hits a failure it cannot read: a bare `{ InstructionError: [1, { Custom: 6001 }] }`, a `"BlockhashNotFound"`, a log wall ending in `custom program error: 0x1771`. Protocol integration skills tell an agent how to build the call; none of them tell it what to do when the call comes back broken. This skill closes that loop.

The procedure is always the same four steps: **classify -> decode -> locate -> remediate**. A fifth path, **simulate-before-sign**, runs the same machinery on an unsigned transaction so you catch the failure before it costs a fee.

Use this skill when you have any of these three inputs:
1. A failed transaction **signature** (you can fetch it from RPC).
2. A raw **error object** from an RPC `sendTransaction` / `simulateTransaction` call, or a caught SDK error.
3. An **unsigned transaction** you are about to send and want to vet first.

This skill is read-only diagnosis and simulation. It never blind-resends. It complements source-bug skills (`vulnhunter`, `zz-code-recon`) and holdings skills (`wallet-analysis`): those find bugs in code or report balances; this one explains a live runtime failure.

## Instructions

Run the steps in order. Each step has an exit condition. Stop early only when the failure class is already fully resolved (for example, a `BlockhashNotFound` needs no instruction-level decode).

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

### Step 2: Classify the failure

Map `err` to exactly one class. See `resources/error-classes.md` for the full taxonomy and variant table. The decision tree:

1. `err` is the string `"BlockhashNotFound"` or `"AlreadyProcessed"`, or the tx was not found at all -> **dropped / blockhash-expired** (the transaction never executed).
2. `err` is an object `{ InsufficientFundsForRent: { account_index } }` -> **rent** class.
3. `err` is an object `{ InstructionError: [index, detail] }` -> a per-instruction failure. Read `detail`:
   - `detail === { Custom: N }` and `N >= 6000` -> **Anchor custom error** class.
   - `detail === { Custom: N }` and `N < 6000` -> **native / built-in program error** class (often SPL Token, e.g. `0x1 = 1` insufficient funds).
   - `detail` is a string like `"PrivilegeEscalation"`, `"ProgramFailedToComplete"`, `"ComputeBudgetExceeded"` -> **raw InstructionError variant** class. `"ComputeBudgetExceeded"` is the **compute-budget** class specifically.
4. `err` is any other bare string or object with no `InstructionError` (e.g. `"AccountNotFound"`, `"AccountInUse"`, `"SignatureFailure"`) -> **transaction-level error** class.

Record `instructionIndex = err.InstructionError?.[0]` when present: you need it in Step 3.

**Success criterion:** Exactly one class is assigned, and (for instruction errors) you have the failing top-level instruction index.

### Step 3: Decode the cause

The goal is a human-readable name and message. See `resources/decode-reference.md` for every decode path. Order of attempts:

1. **Parse the logs first.** Anchor already prints the answer in most cases:
   `Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: ...`. Native programs and `require!`-style checks also log human strings. If a decoded `Error Code`/`Error Message` line exists, you are done: use it.
2. **Convert hex codes.** A log line `custom program error: 0x1771` carries the code in hex. Parse it: `parseInt("0x1771", 16) === 6001`. Then resolve that number as in step 3 or 4.
3. **IDL lookup by code (Anchor custom, code >= 6000).** Load the failing program's IDL (`Program.fetchIdl(programId, provider)` to pull it from the on-chain IDL account, or a bundled copy). Find `idl.errors.find(e => e.code === N)` -> `{ code, name, msg }`. Report `name` and `msg`.
4. **Anchor framework ranges (code >= 100 and < 6000).** These are built-in Anchor errors, not your program's. Resolve the range to a meaning: Instruction ~100, Constraint 2000-2999, Account 3000-3999, etc. See the range table in `resources/error-classes.md`.
5. **Native code (code < 100, or string InstructionError variant).** Resolve against the offending program. For SPL Token codes use the `TokenError` mapping (`1 = InsufficientFunds`, `4 = OwnerMismatch`, etc.). For SDK / system-level errors use `@solana/errors`: `npx @solana/errors decode <code>` from the CLI, or `isSolanaError(e)` plus the package decoder in code.
6. **Third-party fallback.** If the code belongs to a program whose IDL you cannot fetch, resolve against an offline registry (the community `tenequm/solana-idls` bundle, ~1,914 error defs across 41 protocols) keyed by `(programId, code)`. If still unknown, report the raw code and the program id and say it is unresolved rather than guessing.

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

So a `Custom: 6001` on instruction index 1 is Orca's `SlippageExceeded`, not Jupiter's. See the CPI-stack parser in `examples/diagnose-signature.ts`.

**Success criterion:** You can name (a) the top-level instruction index, (b) the program that actually reverted, and (c) for rent/funds errors, the account index involved.

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

Run this on an **unsigned** transaction before it is ever signed.

```ts
const sim = await connection.simulateTransaction(tx, {
  sigVerify: false,            // tx is not signed yet
  replaceRecentBlockhash: true, // ignore a stale/missing blockhash for the dry run
});
```

`sim.value` returns `{ err, logs, unitsConsumed, accounts, returnData }`. Then:

1. If `sim.value.err !== null`, feed `err` and `logs` into Steps 2 through 4 above and return **no-go** with the decoded reason.
2. If `err === null`, report `unitsConsumed`, the programs touched (from `invoke` log lines), the writable accounts, and (if requested) pre/post SOL and token balance deltas computed from `accounts`. Return **go**.
3. Use `unitsConsumed` to set the real compute limit before signing: `setComputeUnitLimit(unitsConsumed * 1.15)` rounded up. This prevents the compute-budget-exceeded class entirely.

**Success criterion:** A go/no-go verdict with `unitsConsumed`, programs touched, and (on no-go) the same structured diagnosis as the post-mortem path.

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

The agent runs `examples/simulate-before-sign.ts`: `simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true })`. On `err === null` it reports `unitsConsumed: 41320`, programs touched `[System, Token, whirL...]`, payer SOL delta `-0.002 SOL`, and verdict **GO**, plus a recommended `setComputeUnitLimit(47518)`. On any `err` it returns **NO-GO** with the decoded reason from Steps 2 to 4, before a single lamport is spent.

## Guidelines

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

- `resources/error-classes.md` - classification taxonomy, `TransactionError` variant table, Anchor framework error ranges, and the full remediation map.
- `resources/decode-reference.md` - native vs Anchor vs hex decode paths, the IDL `errors`-array lookup, `@solana/errors` CLI, and the offline registry + on-chain IDL auto-fetch fallback.
- `examples/diagnose-signature.ts` - fetch, classify, decode (logs first, IDL fallback), CPI-stack locate, structured diagnosis with remediation. Runnable with `@solana/web3.js`.
- `examples/simulate-before-sign.ts` - simulate an unsigned `VersionedTransaction`, report `unitsConsumed`, programs touched, balance deltas, and a go/no-go.
- Solana `getTransaction` RPC: https://solana.com/docs/rpc/http/gettransaction
- Solana `simulateTransaction` RPC: https://solana.com/docs/rpc/http/simulatetransaction
- `TransactionError` enum (agave): https://github.com/anza-xyz/agave/blob/master/sdk/transaction-error/src/lib.rs
- Anchor error reference: https://www.anchor-lang.com/docs/errors
- `@solana/errors` package: https://github.com/anza-xyz/kit/tree/main/packages/errors
- Community error/IDL registry: https://github.com/tenequm/solana-idls
