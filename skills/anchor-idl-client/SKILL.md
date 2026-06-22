---
name: anchor-idl-client
description: Work with ANY Anchor program from its IDL alone, without the program source. Build a typed Program client, decode raw account data, and parse on-chain events and logs. Use when you have a program id but no source, when you need to read or filter another program's accounts, decode a base64 account, turn "Program data:" log lines into typed events, or resolve an account/event discriminator. Keywords: Anchor IDL, decode account, parse events, BorshCoder, BorshAccountsCoder, EventParser, fetchIdl, typed client, account discriminator, Program.account, coral-xyz anchor.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Anchor IDL Client

Drive any Anchor program from its IDL: construct a typed `Program` client, decode account data with the correct 8-byte discriminator, and parse emitted events out of transaction logs. You do not need the program's Rust source or a generated SDK; the IDL is enough, and you can pull the IDL from the chain when you do not already have it.

## Overview

An Anchor IDL is the machine-readable contract for a program: its instructions, account layouts, event layouts, custom errors, and (since Anchor 0.30) the program `address` and every discriminator. Given that one JSON file, the `@coral-xyz/anchor` runtime can do three things you otherwise would have to hand-roll against raw bytes:

1. **Build a typed client.** `new Program(idl, provider)` exposes `program.account.<name>.fetch/all`, `program.methods.<ix>(...)`, and `program.coder` without any codegen step.
2. **Decode account data.** `program.account.<name>.fetch(pubkey)` reads the account, strips the 8-byte discriminator, and Borsh-decodes the rest into a typed object. `BorshAccountsCoder` is the layer that does this.
3. **Parse events and logs.** `new EventParser(programId, coder).parseLogs(logMessages)` turns the base64 `Program data:` lines Anchor emits via `emit!` back into typed event objects.

Reach for this skill whenever you are integrating with a program you did not write: reading another protocol's on-chain state, building an indexer, decoding an account someone handed you as base64, or attributing a log line to a named event. It is the read/decode counterpart to skills that send transactions; it does not sign or submit anything.

The version of `@coral-xyz/anchor` matters and is the single biggest source of breakage. The notes below target the 0.30.x line. Where a signature or IDL field changed across versions, that difference is called out explicitly so you can adapt to the version actually installed. Verify the installed version (`npm ls @coral-xyz/anchor`) before assuming a constructor shape.

## Instructions

Work through the steps in order. Each has a success criterion. You can stop after Step 2 if all you need is the IDL, after Step 4 if you only need account data, or after Step 5 if you only need events.

### Step 1: Pin the Anchor version and obtain the IDL

The IDL format and the `Program` constructor both changed at 0.30. Establish which you are on first.

- Check the installed runtime: `npm ls @coral-xyz/anchor`. The examples here target `0.30.x`.
- If you already have the IDL JSON (bundled in the repo, or copied from an explorer), load it and confirm its shape. A 0.30 IDL has a top-level `"address"` string and `"discriminators"` baked into accounts/instructions/events. A pre-0.30 IDL has `"version"` and `"name"` at the top level and no embedded discriminators.
- If you do NOT have the IDL, fetch it from the chain (Step 2).

**Success criterion:** You know the Anchor major/minor version and you have an IDL object whose format matches it.

### Step 2: Fetch the IDL from the chain when you do not have it

Anchor can publish a program's IDL to an on-chain account at a PDA derived from the program id. Pull it without any local file:

```ts
import { Program, AnchorProvider } from "@coral-xyz/anchor";

const provider = AnchorProvider.env(); // or new AnchorProvider(connection, wallet, {})
const idl = await Program.fetchIdl(programId, provider);
```

- `fetchIdl` returns the IDL object, or `null` if the program never published one on chain. Many programs do not publish, so always handle `null`: fall back to a bundled copy, an explorer export, or report that no IDL is available.
- The fetched IDL is compressed on chain; `fetchIdl` inflates it for you. You only need a `provider` with a working `connection`; no wallet signing is involved in a read.

**Success criterion:** You have an IDL object, or you have confirmed (`null`) that the program did not publish one and have chosen a fallback source.

### Step 3: Construct the typed client

```ts
import { Program } from "@coral-xyz/anchor";

// Anchor 0.30.x: the program id comes from idl.address.
const program = new Program(idl, provider);
```

Version difference, important:

- **0.30.x:** `new Program(idl, provider)`. The program id is read from `idl.address`; you do NOT pass it separately.
- **Pre-0.30 (e.g. 0.29):** `new Program(idl, programId, provider)`. The program id is a separate `PublicKey` argument and the IDL has no `address` field.

If TypeScript types matter, pass the generated `IdlTypes`/program type as the generic; for pure decoding you can treat the IDL as untyped JSON and still get correct runtime decoding.

**Success criterion:** `program.programId` matches the program you intend to read, and `program.account`, `program.coder`, and `program.methods` are populated.

### Step 4: Read and decode accounts

The client decodes raw account bytes using the IDL layout. The account name is the camelCased version of the IDL account name.

```ts
// One account by address:
const data = await program.account.myAccount.fetch(somePubkey);

// All accounts of this type owned by the program, with optional filters:
const all = await program.account.myAccount.all();

// Filter by a field's bytes (memcmp on the raw layout):
const filtered = await program.account.myAccount.all([
  { memcmp: { offset: 8, bytes: someBase58 } }, // offset 8 = first field, after the discriminator
]);
```

What happens under the hood, and the gotchas:

- The first 8 bytes of every Anchor account are the **account discriminator**, `sha256("account:" + AccountName).slice(0, 8)`. `BorshAccountsCoder.decode` checks this and strips it before Borsh-decoding the rest. A mismatched IDL throws a discriminator or layout error here.
- `all([...])` filters run as `getProgramAccounts` `memcmp` against the **raw on-chain layout**, so every offset must account for the leading 8 discriminator bytes. The first declared field starts at offset 8, not 0.
- Decoding a single base64 blob you already have (no fetch): `program.coder.accounts.decode("MyAccount", buffer)` where `buffer` is the full account data including the discriminator.

**Success criterion:** `fetch`/`all` return typed objects with the expected fields, and any `memcmp` offsets are computed from offset 8 onward.

### Step 5: Parse events and logs

Anchor `emit!` events are written to the transaction log as base64 in `Program data:` lines (CPI-mode `emit_cpi!` events instead live in instruction data; those need a different path, noted below). To turn logs into typed events:

```ts
import { BorshCoder, EventParser } from "@coral-xyz/anchor";

const coder = new BorshCoder(idl);
const parser = new EventParser(programId, coder);

const tx = await connection.getTransaction(signature, {
  maxSupportedTransactionVersion: 0,
});
for (const event of parser.parseLogs(tx?.meta?.logMessages ?? [])) {
  console.log(event.name, event.data);
}
```

- `parseLogs` is a generator; iterate it. Each yielded item is `{ name, data }` where `data` is the Borsh-decoded event struct.
- The event discriminator is `sha256("event:" + EventName).slice(0, 8)`, prepended to the encoded struct inside the base64 payload. The parser matches it against the IDL's event definitions.
- Pass `maxSupportedTransactionVersion: 0` to `getTransaction` or it returns `null` for v0 transactions and you will think there are no logs.
- `emit_cpi!` (CPI events) does NOT write `Program data:` lines; it embeds the event in a self-CPI instruction's data. `parseLogs` will not see those. To decode CPI events, read the inner instruction data and use `coder.events.decode(base64Data)` on the event payload. Flag this case if your target program uses `emit_cpi!`.

**Success criterion:** Each emitted event in the transaction is yielded with its IDL name and a decoded `data` object.

### Step 6: Verify the IDL matches the deployed program

Every decode path above assumes the IDL describes the bytes actually on chain. When it does not, you get discriminator errors, garbage field values, or silently wrong numbers.

- If a `fetch` throws an "Invalid account discriminator" (or similar) error, the IDL account name or layout does not match. Re-pull the IDL (Step 2), confirm the account name, and confirm the Anchor version.
- If fields decode but values look wrong (huge u64s, misaligned strings), the IDL is stale relative to a redeployed program. Prefer the on-chain `fetchIdl` copy, which the program author published alongside the deployed code.

**Success criterion:** Decoded accounts and events have sane, expected values, with no discriminator exceptions.

## Examples

### Example 1: Decode another program's accounts from just its program id

User input: "Here is a program id, list its accounts of type `Vault`. I do not have the IDL or the source."

The agent runs `examples/decode-accounts.ts`:

1. **Fetch the IDL** with `Program.fetchIdl(programId, provider)`. If it returns `null`, stop and tell the user the program did not publish an IDL; ask for a bundled copy.
2. **Construct** `new Program(idl, provider)` (0.30.x; program id comes from `idl.address`).
3. **Read** `program.account.vault.all()` to decode every `Vault` account owned by the program, or `.all([{ memcmp: { offset: 8, bytes } }])` to filter by the first field.
4. **Report** each decoded account: its pubkey plus the typed fields.

The same `program.coder.accounts.decode("Vault", buffer)` call decodes a single base64 account someone hands you, without any RPC fetch.

### Example 2: Turn a transaction's logs into typed events

User input: "What events did this transaction emit? Signature `5xq...abc`, here is the IDL."

The agent runs `examples/parse-events.ts`:

1. **Build the coder** `new BorshCoder(idl)` and `new EventParser(programId, coder)`.
2. **Fetch the transaction** with `getTransaction(sig, { maxSupportedTransactionVersion: 0 })` and take `meta.logMessages`.
3. **Parse** by iterating `parser.parseLogs(logs)`; each item is `{ name, data }`.
4. **Report** every event name and its decoded fields. If nothing is yielded, check whether the program uses `emit_cpi!` (events are not in the logs then) and whether the IDL matches the deployed program.

### Example 3: Resolve a discriminator by hand

User input: "Is this 8-byte prefix an account or an event, and which one?"

Compute both candidates and compare:

```ts
import { createHash } from "node:crypto";
const disc = (kind: "account" | "event", name: string) =>
  createHash("sha256").update(`${kind}:${name}`).digest().subarray(0, 8);

// disc("account", "Vault") -> the 8 bytes that lead every Vault account
// disc("event", "TradeEvent") -> the 8 bytes that lead a TradeEvent payload
```

Match the observed prefix against `disc("account", name)` for every account name in the IDL, then against `disc("event", name)` for every event name. (Note: Anchor 0.30 IDLs already include these as `discriminators` on each definition, so you can compare directly without recomputing. The hash recipe is the fallback for older IDLs that omit them.)

## Guidelines

- **DO** check the installed `@coral-xyz/anchor` version before assuming a constructor shape. 0.30 dropped the separate `programId` argument; older versions require it.
- **DO** prefer `Program.fetchIdl` when you lack the IDL, and always handle the `null` (not-published) case explicitly.
- **DO** compute `memcmp` offsets from byte 8 onward; the first 8 bytes are the discriminator, so the first IDL field is at offset 8.
- **DO** pass `maxSupportedTransactionVersion: 0` to `getTransaction` before parsing logs, or v0 transactions return `null`.
- **DO** prefer the on-chain `fetchIdl` copy over a stale bundled IDL when values decode wrong; it tracks the deployed code.
- **DON'T** assume an IDL matches the deployed program. A mismatch surfaces as a discriminator error or as plausibly-wrong field values; verify before trusting decoded data.
- **DON'T** expect `emit_cpi!` (CPI) events to appear in `parseLogs`. Those live in inner-instruction data and need `coder.events.decode` on that payload instead.
- **DON'T** hand-roll Borsh layouts when the IDL is available; let `BorshCoder` / `BorshAccountsCoder` do it so the discriminator handling is correct.
- **DON'T** use a camelCase vs PascalCase name inconsistently: the client accessor is camelCase (`program.account.myAccount`), but `coder.accounts.decode("MyAccount", buf)` uses the PascalCase IDL name.

## Common Errors

### Error: `Cannot read properties of undefined` from `new Program(idl, ...)` / wrong argument count
**Cause:** Anchor version skew. On 0.30.x the constructor is `new Program(idl, provider)` and reads the id from `idl.address`; pre-0.30 it is `new Program(idl, programId, provider)`.
**Solution:** Check `npm ls @coral-xyz/anchor` and use the matching signature. On 0.30, ensure the IDL actually has an `address` field.

### Error: `Invalid account discriminator` on `fetch`/`decode`
**Cause:** The IDL does not match the bytes on chain: wrong account name, stale IDL, or wrong program.
**Solution:** Re-pull the IDL with `fetchIdl`, confirm the account name (PascalCase for `coder`, camelCase for `program.account`), and confirm the Anchor version that generated the IDL.

### Error: `Program.fetchIdl` returns `null`
**Cause:** The program never published its IDL to the on-chain IDL account.
**Solution:** Source the IDL another way (bundled copy, explorer export, the project repo) and load it from disk; do not treat `null` as "no accounts".

### Error: `parseLogs` yields nothing for a transaction you know emitted events
**Cause:** Either you passed `null` logs (forgot `maxSupportedTransactionVersion: 0` on `getTransaction`), the program uses `emit_cpi!` (events not in logs), or the `programId`/IDL passed to `EventParser` is wrong.
**Solution:** Confirm `logMessages` is populated, confirm the program id, and if the program uses CPI events, decode the inner-instruction data with `coder.events.decode` instead.

### Error: `memcmp` filter on `.all([...])` returns nothing
**Cause:** Offset computed from 0 instead of 8, ignoring the leading discriminator, or wrong byte encoding.
**Solution:** Add 8 to the field offset (first field is at offset 8) and pass the comparison value in the encoding `getProgramAccounts` expects (base58 by default).

## References

- `resources/idl-and-discriminators.md` - IDL format (0.30 vs pre-0.30), the account/event discriminator recipes, the `Program` constructor version differences, and the `coder` decode entry points.
- `examples/decode-accounts.ts` - fetch the IDL on chain, build the client, and `program.account.x.all()` with a `memcmp` filter; also single-blob `coder.accounts.decode`. Runnable with `@coral-xyz/anchor` + `@solana/web3.js`.
- `examples/parse-events.ts` - build `BorshCoder` + `EventParser` and turn a transaction's `logMessages` into typed events.
- Anchor `Program` client: https://www.anchor-lang.com/docs/clients/typescript
- Anchor IDL spec and format: https://www.anchor-lang.com/docs/idl
- `@coral-xyz/anchor` on npm (check installed version): https://www.npmjs.com/package/@coral-xyz/anchor
- Anchor events (`emit!` / `emit_cpi!`): https://www.anchor-lang.com/docs/features/events
