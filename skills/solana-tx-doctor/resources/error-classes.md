# Error Classes, TransactionError Variants, and Remediation Map

This is the lookup table for Step 2 (classify) and Step 5 (remediate). Resolve the failure into exactly one class, then apply the matching remediation.

## The classification taxonomy

A Solana failure is reported as a `TransactionError`. There are roughly 39 variants in the enum, but for diagnosis they collapse into seven classes:

| Class | How to recognize it | Did it execute on chain? |
|-------|---------------------|--------------------------|
| **dropped / blockhash-expired** | `getTransaction` returns `null` and height passed `lastValidBlockHeight`; or `err === "BlockhashNotFound"`; or `err === "AlreadyProcessed"`. | NO. Never landed. |
| **anchor-custom-error** | `{ InstructionError: [i, { Custom: N }] }` with `N >= 6000`. | YES. Reverted. |
| **native / built-in program error** | `{ InstructionError: [i, { Custom: N }] }` with `N < 6000` (built-in program, often SPL Token). | YES. Reverted. |
| **compute-budget-exceeded** | `{ InstructionError: [i, "ComputeBudgetExceeded"] }`, or a log ending in `exceeded CUs`. | YES (partial). Reverted. |
| **rent** | `{ InsufficientFundsForRent: { account_index } }`. | YES. Reverted at account creation. |
| **raw InstructionError variant** | `{ InstructionError: [i, "<StringVariant>"] }` (not Custom, not ComputeBudgetExceeded). | YES. Reverted. |
| **transaction-level error** | A bare string or object with NO `InstructionError` (e.g. `"AccountNotFound"`, `"AccountInUse"`, `"SignatureFailure"`). | Usually NO (rejected before/at load). |

Key dividing line for retry safety: only the **dropped** class never executed. Every class with `InstructionError` or `InsufficientFundsForRent` **landed and reverted**, so it is final and must not be blind-retried.

## TransactionError variant table

The most common shapes an agent will see, with cause and fix. Variants come from the agave `TransactionError` enum.

| Variant (`err`) | Meaning | Typical cause | Fix |
|-----------------|---------|---------------|-----|
| `"BlockhashNotFound"` | Recent blockhash not known to the leader. | Built with a stale/expired blockhash, or sent too late. | Fresh blockhash, re-sign, resend. Safe retry. |
| `"AlreadyProcessed"` | This exact blockhash+signature already processed. | Resent an identical tx. | If you need a new effect, rebuild with a fresh blockhash. |
| `{ InstructionError: [i, { Custom: N }] }` | Program at instruction `i` returned error code `N`. | Program assertion (`require!`, `err!`) or built-in check failed. | Decode `N` (see decode-reference.md), fix the input. No blind retry. |
| `{ InstructionError: [i, "ComputeBudgetExceeded"] }` | Instruction exceeded its CU limit. | No/low compute-unit limit for a heavy instruction or CPI. | `setComputeUnitLimit(simUnits * 1.15)`. |
| `{ InstructionError: [i, "ProgramFailedToComplete"] }` | Program aborted (panic, unhandled error, runtime limit). | A `panic!`, unwrap, or resource limit inside the program. | Simulate to read the panic log; fix inputs or raise CU. |
| `{ InstructionError: [i, "PrivilegeEscalation"] }` | An inner instruction needed a privilege (signer/writable) not granted to it. | CPI passes an account as signer/writable that the outer tx did not mark so. | Mark the account signer/writable on the outer instruction. |
| `{ InstructionError: [i, "MissingRequiredSignature"] }` | A required signer for instruction `i` did not sign. | Forgot to add a signer keypair. | Add the signer and re-sign. |
| `{ InstructionError: [i, "AccountNotExecutable"] }` | Tried to invoke a non-program account as a program. | Wrong program id passed. | Use the correct program id. |
| `{ InstructionError: [i, "IncorrectProgramId"] }` | Account owned by a different program than expected. | Mixing SPL Token and Token-2022, or wrong owner. | Use the mint's actual owner program (see remediation map). |
| `{ InsufficientFundsForRent: { account_index } }` | An account ended below rent-exemption. | Created an account without enough lamports. | Fund it to rent-exemption (token account ~0.00204 SOL). |
| `"AccountNotFound"` | A referenced account does not exist. | Address typo, or account never created. | Create/fund the account or fix the address. |
| `"AccountInUse"` | A writable account is locked by another in-flight tx. | Two txs write the same account in the same slot. | Serialize the writes or retry after the lock clears. |
| `"AccountLoadedTwice"` | The same account appears twice as writable. | Duplicate account in the instruction's account list. | Deduplicate the account keys. |
| `"SignatureFailure"` | A signature did not verify. | Wrong key signed, or message changed after signing. | Re-sign with the correct key over the final message. |
| `"InvalidAccountForFee"` / `"InsufficientFundsForFee"` | Fee payer cannot pay the fee. | Payer has no SOL. | Fund the fee payer. |
| `"WouldExceedMaxBlockCostLimit"` / `"WouldExceedMaxAccountCostLimit"` | Block/account compute cost cap reached. | Network congestion or an over-heavy tx. | Lower CU, add priority fee, retry later. Safe to rebuild and retry. |

## Anchor framework error ranges

Codes from `{ Custom: N }` are NOT all your program's custom errors. Anchor reserves fixed ranges defined by `anchor_lang::error::ErrorCode`. Resolve the range first:

| Code range | Origin | Meaning |
|------------|--------|---------|
| < 100 | Native program | Built-in program error code (e.g. SPL Token `TokenError`). Resolve against that program. |
| ~100 (Instruction) | Anchor | Instruction-level errors (missing/fallback instruction, etc.). |
| 1000 - 1999 (IDL) | Anchor | IDL-related instruction build errors. |
| 2000 - 2999 (Constraint) | Anchor | Account constraint failed: `2000 ConstraintMut`, `2001 ConstraintHasOne`, `2002 ConstraintSigner`, `2003 ConstraintRaw`, `2006 ConstraintSeeds`, `2012 ConstraintAddress`. The `require!` family also lives here: `2500 RequireViolated`, `2501 RequireEqViolated`. |
| 3000 - 3999 (Account) | Anchor | Account-state errors: `3002 AccountDiscriminatorMismatch`, `3007 AccountOwnedByWrongProgram`, `3012 AccountNotInitialized`. |
| 4100 (DeclaredProgramIdMismatch) | Anchor | The `declare_id!` value did not match the executing program id. |
| 5000 - 5999 | Anchor | Misc framework (deprecated, event, etc.). |
| >= 6000 | YOUR program | Your `#[error_code]` enum, starting at 6000. Look it up in the IDL `errors` array. |

So `Custom: 2001` is Anchor's `ConstraintHasOne` (a wrong account was passed), not your program's error number 2001. `Custom: 6001` is the second variant of your `#[error_code]` enum.

## Remediation map (class -> concrete fix)

| Class | Safe to retry as-is | Concrete remediation |
|-------|---------------------|----------------------|
| dropped / blockhash-expired | **YES** (never executed) | `getLatestBlockhash`, set it on the message, re-sign, resend, confirm against the new `lastValidBlockHeight`. |
| compute-budget-exceeded | After fix | Read simulated `unitsConsumed`, add `ComputeBudgetProgram.setComputeUnitLimit(Math.ceil(unitsConsumed * 1.15))` as the first instruction. Add `setComputeUnitPrice` for priority. |
| rent (InsufficientFundsForRent) | After fund | Compute rent with `getMinimumBalanceForRentExemption(dataLen)`; a standard SPL token account (165 bytes) needs ~0.00204 SOL. Fund the account, rebuild. |
| anchor-custom (slippage/deadline/auth) | **NO** (reverted, final) | Surface the decoded name + message. Fix the input: re-quote and raise `slippageBps`, refresh a deadline, correct an amount or authority. Build a fresh tx. |
| native / built-in (SPL Token etc.) | **NO** (reverted, final) | Surface the decoded reason. Common: insufficient token balance, wrong token owner, wrong token program. Correct the instruction, build a fresh tx. |
| raw InstructionError variant | Depends | `PrivilegeEscalation` -> fix signer/writable flags. `MissingRequiredSignature` -> add signer. `ProgramFailedToComplete` -> simulate, fix panic cause or raise CU. `IncorrectProgramId` -> use correct program. |
| transaction-level | After fix | `AccountNotFound` -> create/fund/correct address. `SignatureFailure`/`MissingSignature` -> add signer, re-sign. `AccountInUse` -> deduplicate or retry after lock clears. `InsufficientFundsForFee` -> fund payer. |

### Two recurring concrete fixes

**Wrong token program (classic SPL vs Token-2022).** A mint created under Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) is owned by Token-2022, not classic SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). Building an instruction with the wrong token program id yields `IncorrectProgramId` / `3007`. Resolve by reading the mint account's `owner` and using that as the token program.

**Missing compute budget.** Heavy instructions and multi-CPI swaps routinely exceed the default per-instruction CU. Always prepend `setComputeUnitLimit` (sized from simulation) and `setComputeUnitPrice` (for inclusion under load).

## Security rules (do not violate)

- NEVER blind-retry a transaction that REVERTED. It can re-run a partially intended action or burn fees in a loop.
- ONLY retry transactions that were DROPPED and never landed.
- NEVER re-sign and resend after `lastValidBlockHeight` has passed without fetching a fresh blockhash first.
- Treat a confirmed-but-`err` transaction as FINAL. Do not retry it.
