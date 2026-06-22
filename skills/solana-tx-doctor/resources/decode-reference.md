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

## Path 2: Convert hex codes to decimal

Log codes are hex; `meta.err` codes are decimal. Convert before any lookup.

```ts
const code = parseInt("0x1771", 16); // 6001
// 0x1 = 1, 0x6 = 6, 0xbc4 = 3012, 0x1771 = 6001
```

Then route by range (see error-classes.md): `< 100` native, `100..5999` Anchor framework, `>= 6000` your program's IDL.

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

## Decode order, summarized

1. Logs (Anchor decoded line, `require!` string).
2. Hex -> decimal conversion.
3. IDL `errors` array lookup for code >= 6000 (on-chain `fetchIdl` or bundled).
4. Anchor framework range table for 100..5999.
5. Native `TokenError` / `@solana/errors` for code < 100 and SDK errors.
6. Offline registry / on-chain IDL fallback for third-party programs, else report unresolved.

## References

- Anchor `errors` IDL field and `fetchIdl`: https://www.anchor-lang.com/docs/errors
- Anchor `error.rs` (framework codes): https://github.com/solana-foundation/anchor/blob/master/lang/src/error.rs
- SPL Token `TokenError`: https://github.com/solana-program/token/blob/main/program/src/error.rs
- `@solana/errors`: https://github.com/anza-xyz/kit/tree/main/packages/errors
- Community IDL/error registry: https://github.com/tenequm/solana-idls
