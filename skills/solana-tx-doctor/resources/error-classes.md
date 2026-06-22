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

## Dropped vs reverted: the one detection that prevents fund-loss bugs

Before anything else, decide which of two states a transaction is in. They demand opposite actions, and confusing them is the most expensive mistake an agent makes.

**DROPPED (never executed).** `getSignatureStatuses([sig], { searchTransactionHistory: true })` returns a `null` status AND the network's current block height has passed the transaction's `lastValidBlockHeight`. The transaction never landed: no state changed, no fee was charged, there is no on-chain record. It is **safe to rebuild and resend** with a fresh blockhash. (A `null` status while height is still below `lastValidBlockHeight` is not dropped yet; it is in flight, so wait, do not resend.)

**REVERTED (executed, then failed).** `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` returns a record with `meta.err !== null`. The transaction landed in a block, the fee was burned, and the logic failed. It is **final**. Do NOT blindly resend it: the original signature already exists on chain, resending the same bytes does nothing useful, and rebuilding-and-resending can re-run an effect you did not intend to repeat. Fix the underlying cause, then send a NEW transaction only if the operation genuinely did not happen.

**Idempotency safety line.** Before resending anything, ask: did the intended effect already land? If `getTransaction` returns a record (even with `meta.err`, and especially with `meta.err === null`), the answer for that signature is "it already landed, do not resend." Resend only a transaction you have positively confirmed is DROPPED by the two-part test above. When in doubt, treat it as landed and do not resend.

The decision in one line: `status === null && height > lastValidBlockHeight` means DROPPED (rebuild + resend on a fresh blockhash); a fetched record with `meta.err` means REVERTED (final, fix the cause, never blind-resend).

## Full TransactionError enum

These are transaction-level outcomes (the whole transaction was rejected or failed before or around execution), distinct from the per-instruction `InstructionError` below. Variant names come from the agave `TransactionError` enum. Several carry a payload (an index or account index).

| Variant (`err`) | Payload | Meaning | Executed? | Fix |
|-----------------|---------|---------|-----------|-----|
| `"AccountInUse"` | none | A writable account is locked by another in-flight transaction this slot. | No | Serialize the writes, or retry after the lock clears (transient). |
| `"AccountLoadedTwice"` | none | The same account appears twice in the account list with a write lock. | No | Deduplicate account keys in the instruction. |
| `"AccountNotFound"` | none | A referenced account does not exist. | No | Create/fund the account or fix the address. |
| `"ProgramAccountNotFound"` | none | The invoked program account does not exist. | No | Use a correct, deployed program id. |
| `"InsufficientFundsForFee"` | none | The fee payer cannot cover the fee. | No | Fund the fee payer with SOL. |
| `"InvalidAccountForFee"` | none | The chosen fee payer is not a valid fee account. | No | Use a system-owned account with SOL as payer. |
| `"AlreadyProcessed"` | none | This exact blockhash + signature was already processed. | No (no new effect) | If you need a new effect, rebuild with a fresh blockhash. |
| `"BlockhashNotFound"` | none | The recent blockhash is unknown to the leader (stale or sent too late). | No | Fresh blockhash, re-sign, resend. Safe retry. |
| `{ "InstructionError": [i, detail] }` | index + detail | Instruction `i` failed. See the InstructionError table. | Yes (reverted) | Decode `detail`, fix per that table. |
| `"CallChainTooDeep"` | none | CPI nesting exceeded the depth limit. | Yes | Flatten the CPI chain. |
| `"MissingSignatureForFee"` | none | The fee payer did not sign. | No | Add the fee payer signature. |
| `"InvalidAccountIndex"` | none | An instruction referenced an out-of-range account index. | No | Rebuild the message; the account list is malformed. |
| `"SignatureFailure"` | none | A signature did not verify. | No | Re-sign with the correct key over the final message. |
| `"InvalidProgramForExecution"` | none | The program cannot be executed (not a valid BPF program). | No | Use a valid program id. |
| `"SanitizeFailure"` | none | The transaction failed structural sanitization. | No | Rebuild; the message is malformed (bad header, ordering, or size). |
| `"ClusterMaintenance"` | none | The cluster is in maintenance. | No | Retry later. Safe. |
| `"AccountBorrowOutstanding"` | none | An account borrow was still outstanding at the transaction boundary. | Yes | Program bug in account borrowing; fix the program. |
| `"WouldExceedMaxBlockCostLimit"` | none | The transaction would exceed the block's compute-cost cap. | No | Lower CU, add priority fee, retry later. Safe to rebuild + retry. |
| `"UnsupportedVersion"` | none | The transaction version is not supported. | No | Use a supported version; pass `maxSupportedTransactionVersion: 0`. |
| `"InvalidWritableAccount"` | none | An account marked writable cannot be written (e.g. a program). | No | Remove the write flag from that account. |
| `"WouldExceedMaxAccountCostLimit"` | none | Per-account compute-cost cap reached. | No | Lower CU on that account's writes, add priority fee, retry later. |
| `"WouldExceedAccountDataBlockLimit"` | none | The block's total account-data write limit was reached. | No | Retry in a later slot; reduce account-data writes. |
| `"TooManyAccountLocks"` | none | The transaction locked more accounts than allowed. | No | Reduce the number of accounts; split the transaction. |
| `"AddressLookupTableNotFound"` | none | A referenced ALT account does not exist. | No | Use a real, current ALT address; fetch it before building. |
| `"InvalidAddressLookupTableOwner"` | none | The ALT account is not owned by the ALT program. | No | Use a genuine lookup table. |
| `"InvalidAddressLookupTableData"` | none | The ALT account data could not be deserialized. | No | Refetch the table; it may be uninitialized or corrupt. |
| `"InvalidAddressLookupTableIndex"` | none | A lookup index points past the table's current length. | No | The table changed after build; refetch it and rebuild the v0 message. |
| `"InvalidRentPayingAccount"` | none | An account would be left in an invalid rent-paying state. | Yes | Fund the account to rent-exemption. |
| `"WouldExceedMaxVoteCostLimit"` | none | The block's vote-cost cap was reached. | No | Validator-side; retry later. |
| `"WouldExceedAccountDataTotalLimit"` | none | The total account-data limit across the block was reached. | No | Retry in a later slot. |
| `{ "DuplicateInstruction": index }` | instruction index | A directive that must be unique appears twice (often two `setComputeUnitLimit`/`setComputeUnitPrice`). | No | Include each compute-budget directive at most once. |
| `{ "InsufficientFundsForRent": { "account_index": n } }` | account index | Account `n` ended below rent-exemption. | Yes | Fund it to rent-exemption (token account ~0.00204 SOL). |
| `{ "ProgramExecutionTemporarilyRestricted": { "account_index": n } }` | account index | Execution of a program touching account `n` is temporarily restricted (throttled). | No | Retry later; the restriction is transient. Safe. |
| `"UnbalancedTransaction"` | none | Lamport sums in and out did not balance (a lamport leak/creation). | Yes | Program bug: an instruction created or destroyed lamports. Fix the program. |
| `"ProgramCacheHitMaxLimit"` | none | The program cache hit its limit during load. | No | Retry; transient loader pressure. Safe. |
| `"CommitCancelled"` | none | The commit was cancelled. | No | Retry. Safe. |

## Full InstructionError variant map

When `err` is `{ InstructionError: [index, detail] }`, the **index is the top-level instruction that failed** (zero-based, into the transaction's instruction list). The actual program may be a CPI deeper than that instruction; resolve it from the CPI stack (decode-reference.md Path 7). `detail` is either a string variant or an object variant.

Object variants:

| `detail` | Carries | Meaning | Fix |
|----------|---------|---------|-----|
| `{ "Custom": N }` | a u32 code | The program returned its own code `N`. | Decode `N`: `>= 6000` Anchor IDL, `100..5999` Anchor framework, `< 100` native program. See decode-reference.md. |
| `{ "BorshIoError": "<msg>" }` | a string | Borsh (de)serialization of instruction data or an account failed. | Account layout or arg encoding is wrong; match the program's expected types/order. |

String variants (the high-value ones):

| `detail` | Meaning | Fix |
|----------|---------|-----|
| `"ComputeBudgetExceeded"` | The instruction used more CU than its limit. | `setComputeUnitLimit(simulatedUnits * 1.15)`. This is the compute-budget class. |
| `"ProgramFailedToComplete"` | The program aborted: a `panic!`, an unhandled error, or a runtime/resource limit. | Simulate to read the panic log; raise CU or fix the inputs that triggered the panic. |
| `"ProgramFailedToCompile"` | The program failed to load/compile. | Loader/deploy problem; use a correctly deployed program. |
| `"AccountDataTooSmall"` | An account's data is smaller than the program required. | Allocate/realloc the account to the needed size. |
| `"InsufficientFunds"` | A balance was too low for the operation (lamports or tokens, program-defined). | Fund the source; correct the amount. |
| `"MissingRequiredSignature"` | A signer required by this instruction did not sign. | Add the signer keypair and re-sign. |
| `"PrivilegeEscalation"` | A CPI passed an account as signer/writable that the outer transaction did not mark so. | Mark the account signer/writable on the outer instruction. |
| `"AccountBorrowFailed"` | The program could not borrow an account (already borrowed). | Program bug in account borrowing; fix the program's `RefCell`/borrow usage. |
| `"ReentrancyNotAllowed"` | A program was re-entered via CPI in a disallowed way. | Remove the re-entrant CPI; restructure the call. |
| `"AccountAlreadyInitialized"` | Tried to initialize an already-initialized account. | Skip init, or use an idempotent create. |
| `"UninitializedAccount"` | Read/used an account that was never initialized. | Initialize it first (or fix the address). |
| `"NotEnoughAccountKeys"` | The instruction was given fewer accounts than it needs. | Pass the full account list the program expects. |
| `"InvalidArgument"` / `"InvalidInstructionData"` | A bad argument or malformed instruction data. | Fix the instruction args/encoding. |
| `"IncorrectProgramId"` | An account is owned by a different program than expected. | Use the account's real owner program (classic SPL vs Token-2022). |
| `"AccountNotExecutable"` | Tried to invoke a non-program account as a program. | Use the correct program id. |
| `"ExecutableModified"` / `"RentEpochModified"` / `"ExternalAccountLamportSpend"` | A program illegally modified protected account fields. | Program bug; fix the program. |
| `"MaxSeedLengthExceeded"` | A PDA seed exceeded 32 bytes. | Shorten the seed. |
| `"MaxInstructionTraceLengthExceeded"` / `"MaxAccountsExceeded"` / `"MaxAccountsDataAllocationsExceeded"` | A runtime ceiling was hit. | Reduce CPI depth, account count, or allocations; split the transaction. |

Note that `ProgramFailedToComplete` is what an Anchor `require!`/panic looks like if the program panics instead of returning a clean error code, and `Custom` is what a clean `return err!(...)` looks like. Both are program-side reverts and neither is safe to blind-retry.

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

## Per-class remediation playbook (the exact safe next action)

One entry per classification. Each says whether the transaction executed, the single safe next action, and the trap to avoid.

### blockhash expiry / dropped
- **Executed?** No. Never landed.
- **Confirm:** `getSignatureStatuses` returns `null` and current height `>` `lastValidBlockHeight`.
- **Safe action:** `getLatestBlockhash()`, set the new `blockhash` on the message (or rebuild the v0 message), re-sign, `sendRawTransaction`, then `confirmTransaction({ signature, blockhash, lastValidBlockHeight })` against the NEW values.
- **Trap:** resending after expiry without a fresh blockhash just expires again. Do not loop on the same bytes.

### compute exceeded (`ComputeBudgetExceeded` / `ProgramFailedToComplete` from CU)
- **Executed?** Yes (partially), reverted.
- **Safe action:** read `unitsConsumed` from a simulation (or `getSimulationComputeUnits`), then prepend `ComputeBudgetProgram.setComputeUnitLimit(Math.ceil(unitsConsumed * 1.15))` as the first instruction. Add `setComputeUnitPrice` for inclusion under load. Default is 200,000 CU per instruction, 1.4M per transaction, so heavy swaps need an explicit limit.
- **Trap:** setting the limit higher than 1,400,000 (the transaction cap) is rejected; if you genuinely need more, split the transaction.

### rent (`InsufficientFundsForRent { account_index }`)
- **Executed?** Yes, reverted at account creation.
- **Safe action:** compute the exact top-up with `connection.getMinimumBalanceForRentExemption(dataLen)`. Common sizes: an empty system account (`dataLen = 0`) needs ~0.00089088 SOL (890,880 lamports); a standard SPL token account (165 bytes) needs ~0.00203928 SOL (2,039,280 lamports); a mint (82 bytes) needs ~0.0014616 SOL (1,461,600 lamports). Fund the account at `account_index` to at least that, then rebuild. Report the exact lamports to add, not just "fund it."
- **Trap:** funding to less than the rent-exempt minimum reverts again; always read the live value for the real data length.

### slippage (DEX `Custom`, very often `0x1771` / 6001)
- **Executed?** Yes, reverted. Fees burned, swap did not happen.
- **Safe action:** do NOT resend. Refresh the quote, widen tolerance (raise `slippageBps`, or `max_sol_cost` / lower `min_sol_output` for pump.fun), rebuild on a fresh blockhash, optionally add a priority fee so the fresh quote lands in time. See `resources/dex-error-codes.md`.
- **Trap:** retrying the same transaction. The quote is stale, so it reverts again or, after expiry, does nothing.

### AccountInUse / dropped lock
- **Executed?** No (rejected at load).
- **Safe action:** for `AccountInUse`, the account is write-locked by another in-flight transaction this slot; retry after the lock clears (transient) or serialize your writes. For `AccountLoadedTwice`, deduplicate the account keys in the instruction, then rebuild.
- **Trap:** treating a genuine duplicate-key bug (`AccountLoadedTwice`) as a transient lock and retrying forever.

### signature / privilege (`MissingRequiredSignature`, `SignatureFailure`, `PrivilegeEscalation`)
- **Executed?** Signature failures: no. PrivilegeEscalation: yes (reverted inside a CPI).
- **Safe action:** `MissingRequiredSignature` -> add the missing signer keypair and re-sign. `SignatureFailure` -> re-sign with the correct key over the FINAL message (the message changed after signing). `PrivilegeEscalation` -> the inner CPI needed a signer/writable privilege the outer instruction did not grant; mark that account signer and/or writable on the outer instruction, then rebuild.
- **Trap:** re-signing without rebuilding the message when the message itself changed; the signature must cover the exact bytes that will be sent.

### rent for stake/system creation
- **Executed?** Yes, reverted.
- **Safe action:** same as rent above, but remember a stake account also needs the rent-exempt minimum for its (larger) data length; never split or withdraw a stake account below rent-exemption (yields `InsufficientStake` or rent failure). See `resources/native-program-errors.md`.

### two recurring concrete fixes

**Wrong token program (classic SPL vs Token-2022).** A mint created under Token-2022 (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`) is owned by Token-2022, not classic SPL Token (`TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`). Building an instruction with the wrong token program id yields `IncorrectProgramId` / `3007`. Resolve by reading the mint account's `owner` and using that as the token program.

**Missing compute budget.** Heavy instructions and multi-CPI swaps routinely exceed the default per-instruction CU. Always prepend `setComputeUnitLimit` (sized from simulation) and `setComputeUnitPrice` (for inclusion under load).

## Security rules (do not violate)

- NEVER blind-retry a transaction that REVERTED. It can re-run a partially intended action or burn fees in a loop.
- ONLY retry transactions that were DROPPED and never landed.
- NEVER re-sign and resend after `lastValidBlockHeight` has passed without fetching a fresh blockhash first.
- Treat a confirmed-but-`err` transaction as FINAL. Do not retry it.

## Related references

- `resources/dex-error-codes.md` for slippage and DEX `Custom` codes (Jupiter, Raydium, Orca, pump.fun, Meteora), the `0x1771` family.
- `resources/native-program-errors.md` for System, Associated Token, Token-2022, Compute Budget, Address Lookup Table, Stake, and Vote error tables.
- `resources/decode-reference.md` for the hex/decimal conversion, Anchor framework ranges, IDL lookup, official primitives, and the CPI-stack reconstruction.
