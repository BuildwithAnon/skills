# IDL Format, Discriminators, and Version Differences

This is the lookup for the mechanics behind the skill: what an IDL contains, how the 8-byte discriminators are derived, how the `Program` constructor and IDL format changed across Anchor versions, and which `coder` method decodes what. All version-specific notes target the `0.30.x` line; verify against the installed version (`npm ls @coral-xyz/anchor`) before relying on a signature.

## What an IDL contains

An Anchor IDL is a JSON description of a program. The fields that matter for reading and decoding:

- `instructions` - each instruction's name, arguments, and account list. Drives `program.methods.<ix>(...)`.
- `accounts` - each account type's name and (in 0.30) its discriminator. Drives `program.account.<name>` and `coder.accounts.decode`.
- `events` - each event's name, fields, and (in 0.30) its discriminator. Drives `EventParser` and `coder.events.decode`.
- `types` - shared struct/enum definitions referenced by accounts, instructions, and events.
- `errors` - custom error codes (>= 6000), with `name` and `msg`.
- `address` (0.30 only) - the program id as a base58 string. This is why the 0.30 constructor no longer needs a separate `programId`.
- `metadata` (0.30) - includes the Anchor/spec version used to generate the IDL.

## The 8-byte discriminators

Every Anchor account and event is prefixed with an 8-byte discriminator so the runtime can tell types apart before decoding.

### Account discriminator

```
discriminator = sha256("account:" + AccountName).slice(0, 8)
```

`AccountName` is the PascalCase type name as declared in the program (and as it appears in the IDL `accounts` array). These 8 bytes lead the raw account data; the actual fields follow at byte offset 8.

### Event discriminator

```
discriminator = sha256("event:" + EventName).slice(0, 8)
```

These 8 bytes lead the encoded event struct inside the base64 `Program data:` payload.

### Instruction discriminator (for completeness)

```
discriminator = sha256("global:" + snake_case_instruction_name).slice(0, 8)
```

Note the `global:` namespace and the snake_case name for instructions, versus `account:`/`event:` with the PascalCase type name. The first 8 bytes of an instruction's data are this discriminator.

### Computing a discriminator in code

```ts
import { createHash } from "node:crypto";

function discriminator(kind: "account" | "event" | "global", name: string): Buffer {
  return createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);
}

// discriminator("account", "Vault")
// discriminator("event", "TradeEvent")
// discriminator("global", "initialize")  // instruction namespace
```

In 0.30 IDLs the discriminator is already stored on each `accounts`/`events`/`instructions` entry as a `discriminator` byte array, so you can read it directly rather than recompute. Recompute only when working with older IDLs that omit it.

## `Program` constructor: version difference

This is the single most common breakage when adapting example code.

| Anchor version | Constructor | Where the program id comes from |
|----------------|-------------|---------------------------------|
| 0.30.x | `new Program(idl, provider)` | `idl.address` (must be present) |
| pre-0.30 (e.g. 0.29) | `new Program(idl, programId, provider)` | the `programId` argument |

On 0.30, if the IDL is missing `address`, construction fails or the program id is wrong; ensure the IDL is a genuine 0.30 export. When porting older snippets to 0.30, drop the middle `programId` argument.

`AnchorProvider` is the same idea across versions: `AnchorProvider.env()` (reads `ANCHOR_PROVIDER_URL` / `ANCHOR_WALLET`), or `new AnchorProvider(connection, wallet, {})`. For read-only decoding you do not need a real signing wallet, but the provider must carry a working `connection`.

## Fetching the IDL from the chain

```ts
const idl = await Program.fetchIdl(programId, provider);
```

- Returns the inflated IDL object, or `null` if the program never published one.
- The on-chain IDL lives in an account at a PDA derived from the program id, written by `anchor idl init`/`upgrade`. Many programs skip publishing, hence the frequent `null`.
- A read; no wallet signature required, only `provider.connection`.

When `fetchIdl` returns `null`, fall back to a bundled IDL, an explorer export, or the project repo. Do not treat `null` as "the program has no accounts".

## The `coder`: which method decodes what

`new BorshCoder(idl)` exposes sub-coders. `program.coder` is the same object on a constructed `Program`.

| Goal | Call | Input |
|------|------|-------|
| Decode a full account blob | `coder.accounts.decode("MyAccount", buffer)` | raw account data including the 8-byte discriminator |
| Encode an account (rare) | `coder.accounts.encode("MyAccount", obj)` | a typed object |
| Decode one event payload | `coder.events.decode(base64OrBuffer)` | a single event payload (e.g. from a CPI event) |
| Decode instruction data | `coder.instruction.decode(data)` | raw instruction data including its discriminator |

`coder.accounts.decode` uses the PascalCase IDL name; the high-level `program.account.<name>` accessor uses the camelCase form of the same name. `EventParser(programId, coder).parseLogs(logs)` is the convenience wrapper over `coder.events` for log-based (`emit!`) events.

## `emit!` vs `emit_cpi!`

- `emit!` writes the event as base64 in a `Program data:` log line. `EventParser.parseLogs` reads these.
- `emit_cpi!` writes the event into a self-CPI instruction's data instead of the log (so it survives even when logs are truncated). `parseLogs` does NOT see these; decode the inner-instruction data with `coder.events.decode` on the event payload (after stripping the CPI event-authority preamble bytes that Anchor prepends).

If a program's events do not show up in `parseLogs`, suspect `emit_cpi!` and switch to the inner-instruction path.

## `memcmp` filtering on `.all([...])`

`program.account.<name>.all(filters)` runs `getProgramAccounts` under the hood, so `memcmp` offsets are measured against the **raw on-chain bytes**, which begin with the 8-byte discriminator.

- The first declared field is at **offset 8**, not 0.
- A `dataSize` filter, if used, must include the 8 discriminator bytes.
- The comparison `bytes` are base58 by default in `@solana/web3.js`.

```ts
// match the first field (e.g. an authority pubkey at the start of the struct)
program.account.vault.all([
  { memcmp: { offset: 8, bytes: authority.toBase58() } },
]);
```

## References

- Anchor IDL spec: https://www.anchor-lang.com/docs/idl
- Anchor TypeScript client (`Program`, `coder`, `account`): https://www.anchor-lang.com/docs/clients/typescript
- Anchor events (`emit!` / `emit_cpi!`): https://www.anchor-lang.com/docs/features/events
- `@coral-xyz/anchor` source (constructor, coders, EventParser): https://github.com/coral-xyz/anchor/tree/master/ts/packages/anchor/src
- `getProgramAccounts` (memcmp/dataSize filters): https://solana.com/docs/rpc/http/getprogramaccounts
