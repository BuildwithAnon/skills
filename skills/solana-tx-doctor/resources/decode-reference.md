# Decode Reference

This is the lookup for Step 3 (decode the cause). The goal is always a human-readable name and message for an error code. Try the paths in order; the first that resolves wins.

## Path 1: Parse the logs first (cheapest, most reliable)

Most failures already carry the answer in `meta.logMessages`. Scan the logs before doing any code resolution.

### Anchor decoded line

Anchor programs print the fully decoded error before reverting:

```
Program log: AnchorError occurred. Error Code: SlippageExceeded. Error Number: 6001. Error Message: Exceeded max slippage tolerance.
```

Or, for account constraints:

```
Program log: AnchorError caused by account: vault. Error Code: ConstraintHasOne. Error Number: 2001. Error Message: A has one constraint was violated.
```

Regex to extract: `Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+)`. If it matches, you are done; no IDL needed.

### `require!` / `msg!` human strings

Programs that use `require!(cond, MyError::Foo)` or `msg!("custom string")` print the message directly. A plain `Program log: <message>` immediately before the `failed` line is usually the cause.

### The raw hex code line

Native and lower-level failures end with:

```
Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x1
Program JUP...Zkt7 failed: custom program error: 0x1771
```

That hex IS the code. Convert it (Path 2) and resolve.

## Path 2: Normalize hex and decimal (do this everywhere)

The same error code appears in two forms and you must convert between them on sight. Program logs print the code in **hex** (`custom program error: 0x1771`); `meta.err` and the IDL `errors` array use **decimal** (`{ Custom: 6001 }`, `"code": 6001`). Never compare across forms without converting first.

```ts
const fromLog = parseInt("0x1771", 16); // 6001  (hex log  -> decimal)
const toLog = (6001).toString(16);      // "1771" (decimal -> hex, for matching a log line)
// 0x1 = 1, 0x10 = 16, 0x1e = 30, 0x6 = 6, 0xbc4 = 3012, 0x1771 = 6001
```

Then route the decimal code by range:

- `< 100` -> native program error (resolve against the program that reverted; see Path 5 and `resources/native-program-errors.md`).
- `100..5999` -> Anchor framework-reserved error (Path 4).
- `>= 6000` -> the program's own `#[error_code]` enum (Path 3, resolve via the IDL `errors` array with the 6000 base).

### Anchor 6000-base resolution

An Anchor `#[error_code]` enum starts at 6000 by default. The enum index is `code - 6000`: `6000` is the first variant, `6001` the second, and so on. The IDL `errors` array stores the absolute code, so look up the absolute number (`6001`), not the offset. This 6000 base is exactly why `0x1771` (6001) is so common: it is the second declared error in a huge number of Anchor DEX programs, and on swaps that second error is usually the slippage check (see `resources/dex-error-codes.md`).

### Anchor framework-reserved ranges (so non-6000 Anchor codes still decode)

A `{ Custom: N }` with `100 <= N < 6000` is NOT in your program's IDL `errors` array, because Anchor reserves these ranges for framework errors. Decode them by range without an IDL:

| Range | Anchor group | What it means | Common members |
|-------|--------------|---------------|----------------|
| 100 - 999 | Instruction | Instruction dispatch errors. | `100 InstructionMissing`, `101 InstructionFallbackNotFound`, `102 InstructionDidNotDeserialize`, `103 InstructionDidNotSerialize`. |
| 1000 - 1999 | IDL instruction | IDL-account build/write errors. | `1000 IdlInstructionStub`, `1001 IdlInstructionInvalidProgram`. |
| 2000 - 2999 | Constraint | An account constraint failed. | `2000 ConstraintMut`, `2001 ConstraintHasOne`, `2002 ConstraintSigner`, `2003 ConstraintRaw`, `2006 ConstraintSeeds`, `2012 ConstraintAddress`, `2019 ConstraintTokenMint`, `2500 RequireViolated`, `2501 RequireEqViolated`, `2503 RequireGtViolated`. |
| 3000 - 3999 | Account | Account-state errors. | `3001 AccountDidNotSerialize`, `3002 AccountDidNotDeserialize`, `3002 AccountDiscriminatorMismatch` group, `3007 AccountOwnedByWrongProgram`, `3009 AccountNotMutable`, `3011 AccountNotSigner`, `3012 AccountNotInitialized`, `3014 AccountNotProgramData`. |
| 4100 | Misc | `DeclaredProgramIdMismatch`: the executing program id did not match `declare_id!`. |
| 5000 - 5999 | Deprecated / misc | Deprecated and miscellaneous framework errors. | `5000 Deprecated` and related. |
| 6000+ | Your program | Your `#[error_code]` enum. Resolve via the IDL (Path 3). |

So `Custom: 2001` is Anchor's `ConstraintHasOne` (the wrong account was passed for a `has_one`), `Custom: 2006` is `ConstraintSeeds` (a PDA derivation mismatch), and `Custom: 3012` is `AccountNotInitialized` (reading an account that was never created). None of these are your program's error number; resolving them against your IDL would give a wrong answer. The authoritative list is anchor `lang/src/error.rs`.

## Path 3: Decode an Anchor custom error via the IDL errors array (code >= 6000)

When the logs do not contain a decoded line (older programs, or logs truncated), look the code up in the program's IDL. Every Anchor IDL has an `errors` array:

```json
"errors": [
  { "code": 6000, "name": "InvalidAmount", "msg": "Amount must be greater than zero" },
  { "code": 6001, "name": "SlippageExceeded", "msg": "Exceeded max slippage tolerance" }
]
```

Resolve by exact code:

```ts
const entry = idl.errors?.find((e) => e.code === code);
// entry => { code: 6001, name: "SlippageExceeded", msg: "Exceeded max slippage tolerance" }
```

### Getting the IDL

1. **On-chain auto-fetch (preferred when you do not have it):** Anchor publishes the IDL to an account at a PDA derived from the program id. Fetch it without local files:

   ```ts
   import { Program } from "@coral-xyz/anchor";
   const idl = await Program.fetchIdl(programId, provider);
   ```

   `fetchIdl` returns `null` if the program never published an IDL on chain. Fall back to Path 5.

2. **Bundled copy:** if you ship the IDL with your app, load it from disk and use the same `find` lookup.

## Path 4: Anchor framework ranges (code >= 100 and < 6000)

These are Anchor's built-in errors, not your program's, so they are not in your `errors` array. Resolve the number to a name from the framework ranges in `error-classes.md`:

- `2001` -> `ConstraintHasOne` (a `has_one` account did not match).
- `2006` -> `ConstraintSeeds` (a PDA derivation did not match; seed encoding or program id wrong).
- `3007` -> `AccountOwnedByWrongProgram` (often classic SPL vs Token-2022 mix-up).
- `3012` -> `AccountNotInitialized` (reading an account that was never created).

Authoritative list: anchor `lang/src/error.rs`.

## Path 5: Native and system-level decode (code < 100, string variants, SDK errors)

### SPL Token (`TokenError`) common codes

| Code | Name | Meaning |
|------|------|---------|
| 0 | NotRentExempt | Lamports below rent-exemption. |
| 1 | InsufficientFunds | Token balance too low for the transfer/burn. |
| 2 | InvalidMint | The mint is invalid (wrong size or not initialized). |
| 3 | MintMismatch | The token account's mint does not match the mint passed to the instruction. |
| 4 | OwnerMismatch | Token account owner is not the expected authority. |
| 5 | FixedSupply | Cannot mint more of a fixed-supply token. |
| 6 | AlreadyInUse | Account already initialized. |

So `custom program error: 0x1` from the Token program is `InsufficientFunds`, not "custom error 1".

### `@solana/errors` for SDK / system-level errors

The modern `@solana/kit` error package decodes framework, RPC, and system-level error codes (not your program's custom codes). Two ways:

**CLI (no code):**

```bash
npx @solana/errors decode <code>
```

**In code:**

```ts
import { isSolanaError } from "@solana/errors";
try {
  // ... build/send
} catch (e) {
  if (isSolanaError(e)) {
    console.log(e.context, e.message); // decoded SDK-level error with context
  }
}
```

Use this path for kit/web3 client-side errors (bad params, account decoding, RPC transport) where there is no on-chain `Custom` code to resolve.

## Path 6: Third-party program fallback (offline registry + on-chain IDL)

When the failing code belongs to a program whose IDL you cannot fetch (no on-chain IDL, no bundled copy):

1. **On-chain IDL auto-fetch** is the first fallback: `Program.fetchIdl(programId, provider)` (Path 3). Many DeFi programs publish their IDL on chain.
2. **Offline error registry:** if `fetchIdl` returns `null`, resolve against a bundled community registry. `tenequm/solana-idls` aggregates ~1,914 error definitions across 41 protocols, keyed by program and code. Look up `(programId, code)` for a name and message offline, no RPC required.
3. **Unresolved:** if neither resolves it, report the raw code and the program id and state it is unresolved. Do NOT invent a meaning.

```ts
function resolveThirdParty(programId: string, code: number, registry: ErrorRegistry) {
  const hit = registry[programId]?.[code];
  if (hit) return hit; // { name, msg }
  return { name: `Custom(${code})`, msg: `Unresolved error ${code} from program ${programId}` };
}
```

## Path 7: Orchestrate the official primitives (never fall behind upstream)

Do not hand-roll what the official packages already do. The most reliable and future-proof decode is to call upstream first and only fall back to hand-parsing. Three primitives matter, all real exports.

### `@solana/errors`: decode the RPC error shapes directly

`@solana/errors` (the `@solana/kit` error package) turns the raw JSON-RPC `TransactionError` and `InstructionError` shapes into typed `SolanaError` objects with a human message and a refined `context`.

```ts
import {
  getSolanaErrorFromTransactionError,
  getSolanaErrorFromInstructionError,
  isSolanaError,
} from "@solana/errors";

// meta.err is a TransactionError (a string or a single-key object).
const e = getSolanaErrorFromTransactionError(metaErr);

// For a per-instruction failure, pass the index and the inner detail.
// e.g. metaErr === { InstructionError: [1, { Custom: 6001 }] }
const ie = getSolanaErrorFromInstructionError(1, { Custom: 6001 });

if (isSolanaError(e)) {
  console.log(e.message, e.context); // decoded SDK-level message + structured context
}
```

`getSolanaErrorFromTransactionError(transactionError)` accepts a `string` or `{ [key: string]: unknown }`. `getSolanaErrorFromInstructionError(index, instructionError)` takes the instruction index (`bigint | number`) and the inner detail. These decode the framework and runtime variants (the full `TransactionError` / `InstructionError` enums). They do NOT know your program's `Custom: >= 6000` codes; for those you still need the IDL (Path 3). The CLI equivalent for a quick lookup is `npx @solana/errors decode <code>`.

### `@solana-developers/helpers`: decode a whole transaction by signature

`decodeAnchorTransaction(connection, signature, configPath?)` fetches the transaction and, for each instruction's program id, fetches that program's IDL and decodes the instruction name, arguments, and accounts. It returns a structured `DecodedTransaction` (with a `.toString()` for a readable dump). Use it to get instruction-level meaning without bundling IDLs by hand.

```ts
import { decodeAnchorTransaction } from "@solana-developers/helpers";

const decoded = await decodeAnchorTransaction(connection, signature);
console.log(decoded.toString()); // each ix: program, name, args, accounts, with roles
```

This is the fast path for "what did this transaction even try to do," and it auto-fetches IDLs by program id, so it stays current with whatever the program published on chain.

### `@solana-developers/helpers`: size the compute budget from simulation

`getSimulationComputeUnits(connection, instructions, payer, lookupTables?)` simulates the given instructions and returns the consumed compute units (a `number`, or `null` if simulation failed). Use it to set a right-sized `setComputeUnitLimit` before signing, which pre-empts the `ComputeBudgetExceeded` class entirely.

```ts
import { getSimulationComputeUnits } from "@solana-developers/helpers";

const units = await getSimulationComputeUnits(connection, instructions, payer.publicKey, lookupTables);
// then prepend ComputeBudgetProgram.setComputeUnitLimit(Math.ceil(units * 1.1)) with headroom
```

### The registry must be GENERATED, not hand-maintained

The offline error registry (Path 6) drifts the moment a program ships a new error. Generate it instead of curating it by hand:

- For framework/runtime codes, derive the table from `@solana/errors` (its codes file is the source of truth) rather than retyping variant names.
- For program codes, derive each program's `(code -> name, msg)` map from its on-chain IDL `errors` array (fetched by program id). Regenerate periodically so new and renumbered errors are captured automatically.

This keeps the doctor in sync with upstream: the offline data is a cached snapshot of generated truth, never a manually edited list that quietly goes stale.

## Path 8: Reconstruct the CPI stack and align it to inner instructions

The top-level `InstructionError[0]` index names the outer instruction, but the program that actually reverted is usually a CPI deeper than that. Reconstruct it precisely, then align it to structured data so the verdict is exact.

### Step A: parse the log frames

Every CPI emits a matched pair around its child program:

```
Program JUP6Lkb... invoke [1]         <- top-level instruction (depth 1)
  Program TokenzQd... invoke [2]      <- CPI into Token-2022 (depth 2)
    Program HookProg... invoke [3]    <- Token-2022 invokes the transfer hook (depth 3)
    Program HookProg... failed: custom program error: 0x1771   <- failure originates here
  Program TokenzQd... failed: ...     <- the parent that called it also fails up the chain
Program JUP6Lkb... failed: ...
```

Walk the lines, maintaining a stack: `Program X invoke [d]` pushes `X` at depth `d`; `Program X success` pops; `Program X failed: <reason>` is where a frame reverted. The **deepest frame at the first `failed` line** is the program that actually reverted. Record its depth and the chain of parents above it.

### Step B: align to `innerInstructions`

Logs can be truncated or noisy. Cross-check against structured data from `getTransaction(sig, { maxSupportedTransactionVersion: 0 })`, whose `meta.innerInstructions` lists, per top-level instruction index, the inner instructions actually executed (with `programIdIndex` and account indexes). For a pre-sign check, request the same data with `simulateTransaction(..., { innerInstructions: true })`. Match the deepest failing program from Step A to the inner-instruction entry under the failing top-level index to confirm which CPI it was.

### Step C: resolve account roles through Address Lookup Tables

For a versioned (v0) transaction, account keys are split between `staticAccountKeys` and keys loaded from Address Lookup Tables. To name the accounts an inner instruction touched (and their signer/writable roles), resolve the lookups:

```ts
import { PublicKey } from "@solana/web3.js";

// From getTransaction: message.addressTableLookups gives the ALT addresses used.
const lookups = tx.transaction.message.addressTableLookups ?? [];
const tables = await Promise.all(
  lookups.map((l) => connection.getAddressLookupTable(new PublicKey(l.accountKey)))
);
const lookupTableAccounts = tables.map((t) => t.value).filter(Boolean);

// Build the full ordered key list (static keys first, then writable-from-lookup, then readonly-from-lookup).
const keys = tx.transaction.message.getAccountKeys({
  addressLookupTableAccounts: lookupTableAccounts as any[],
});
// keys.get(i) now maps any account index (including ALT-sourced) to a PublicKey.
```

`getAddressLookupTable` returns the on-chain table; `message.getAccountKeys({ addressLookupTableAccounts })` reassembles the complete index-to-key mapping including the loaded addresses. Now every account index in `innerInstructions` resolves to a real pubkey.

### Step D: emit the tree plus a verdict

Output an indented tree of the invoke chain and a one-line verdict that names the failing program, its depth, and which top-level instruction called into it:

```
ix #1  JUP6Lkb...        invoke [1]
  +-- TokenzQd...        invoke [2]
        +-- HookProg...  invoke [3]  FAILED: custom program error: 0x1771 (6001)

VERDICT: failing program = HookProg... at depth 3 (transfer hook),
         called by Token-2022 (depth 2), under top-level instruction #1 (Jupiter route).
```

The runnable version of this is `examples/cpi-stack-trace.ts`.

## Decode order, summarized

1. Logs (Anchor decoded line, `require!` string).
2. Normalize hex and decimal (Path 2); route by range.
3. Official primitives first (Path 7): `@solana/errors` for the runtime/framework shapes, `decodeAnchorTransaction` for instruction meaning, `getSimulationComputeUnits` for the CU budget.
4. IDL `errors` array lookup for code >= 6000, with the 6000 base (on-chain `fetchIdl` or bundled).
5. Anchor framework-reserved ranges for 100..5999 (Path 4).
6. Native `TokenError` / native-program tables / `@solana/errors` for code < 100 and SDK errors.
7. Offline (generated) registry / on-chain IDL fallback for third-party programs, else report unresolved.
8. Reconstruct the CPI stack (Path 8) to attribute the failure to the right inner program and emit the tree + verdict.

## References

- Anchor `errors` IDL field and `fetchIdl`: https://www.anchor-lang.com/docs/errors
- Anchor `error.rs` (framework codes): https://github.com/solana-foundation/anchor/blob/master/lang/src/error.rs
- SPL Token `TokenError`: https://github.com/solana-program/token/blob/main/program/src/error.rs
- `@solana/errors` (`getSolanaErrorFromTransactionError`, `getSolanaErrorFromInstructionError`, `isSolanaError`): https://github.com/anza-xyz/kit/tree/main/packages/errors
- `@solana-developers/helpers` (`decodeAnchorTransaction`, `getSimulationComputeUnits`): https://github.com/solana-developers/helpers
- `getTransaction` (`innerInstructions`, `addressTableLookups`): https://solana.com/docs/rpc/http/gettransaction
- `getAddressLookupTable`: https://solana.com/docs/rpc/http/getaddresslookuptable
- Community IDL/error registry (snapshot to generate from): https://github.com/tenequm/solana-idls
- `resources/dex-error-codes.md` and `resources/native-program-errors.md` for the per-program code tables.
