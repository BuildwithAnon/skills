---
name: streamflow
description: Create and manage token vesting and streaming payments on Solana with the Streamflow SDK (@streamflow/stream). Use when a user wants to vest tokens to a team, investor, or contributor over time with a cliff and linear unlock, set up continuous (real-time) salary or grant streams, build a recurring payments flow, withdraw unlocked tokens, cancel or transfer a stream, top up a stream, or query existing streams by recipient/sender. Keywords: token vesting, streaming payments, Streamflow, cliff, linear unlock, vest tokens, salary stream, withdraw vested, cancel vesting, SolanaStreamClient, createStream.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Streamflow Token Vesting and Streaming Payments

Build token vesting schedules and real-time streaming payments on Solana with the Streamflow TypeScript SDK. This skill covers creating a stream (vesting or payment), withdrawing unlocked tokens, cancelling, transferring, topping up, and querying streams, plus the unit, timestamp, fee, and cancellability gotchas that cause most integration bugs.

## Overview

Streamflow locks an amount of an SPL token in an on-chain escrow and releases it to a recipient over a schedule: an optional **cliff** (a lump that becomes available at a single timestamp) followed by **linear unlock** in fixed **periods** of `amountPerPeriod` each. Two shapes share the same `create` call:

- **Vesting** (`canTopup: false`): a fixed total is locked once and unlocks over time. Used for team/investor/advisor token vesting where the total is known up front and must not change.
- **Streaming payment** (`canTopup: true`): a continuous payment that can be refilled with `topup`. Used for salaries, grants, and subscriptions where more funds get added over time.

The same escrow supports `withdraw` (recipient pulls what has unlocked), `cancel` (returns the still-locked remainder per the cancellability flags), `transfer` (hand the recipient role to a new wallet), and `update` (change rate/auto-withdraw when allowed). Reads go through `getOne` and `get`.

Use this skill when the user mentions vesting, cliffs, linear unlock, streaming/continuous payments, salary or grant streams on Solana, or names Streamflow directly. It does NOT cover Streamflow's airdrop/distributor or token-launch products; it is the streams/vesting SDK only.

### When to load

- "Vest 1,000,000 tokens to my team over 2 years with a 6 month cliff."
- "Set up a monthly salary stream of USDC to a contributor."
- "Let the recipient withdraw whatever has unlocked so far."
- "Cancel a vesting stream and return the unvested tokens."
- "List all streams I am sending / receiving."

## Instructions

Follow the steps in order. Each step has a success criterion. Read `resources/api.md` for the full method/enum surface and `resources/addresses.md` for program ids and fees before writing code.

### Step 0: Install and pin the SDK

Install the package:

```bash
npm i -s @streamflow/stream
# @streamflow/common is a transitive dependency (auto-installed) that re-exports
# getBN, getNumberFromBN, ICluster, and ContractError through @streamflow/stream.
```

- Target `@streamflow/stream@12.4.0` (the current published version as of 2026, confirmed on npm). Older guides reference v6 with a `StreamflowSolana`/`GenericStreamClient`/`Types` import surface: that is stale. In v12 the client and enums are top-level named exports.
- The package ships its own TypeScript types, and `@streamflow/common` (a transitive dependency, auto-installed) re-exports `getBN`, `getNumberFromBN`, `ICluster`, and `ContractError` through `@streamflow/stream`.

**Success criterion:** `@streamflow/stream` resolves at v12.4.0 and `import { SolanaStreamClient } from "@streamflow/stream"` type-checks.

### Step 1: Construct a client

Construct a `SolanaStreamClient` with the cluster URL and the matching `ICluster`:

```ts
import { SolanaStreamClient, ICluster } from "@streamflow/stream";

// Mainnet:
const client = new SolanaStreamClient(
  "https://api.mainnet-beta.solana.com", // cluster URL
  ICluster.Mainnet                       // selects the program id for this cluster
);
```

- For devnet, pass both the devnet RPC URL and `ICluster.Devnet`. The program id differs by cluster (see `resources/addresses.md`) and the client picks it from the `ICluster` you pass, defaulting to `Mainnet`. Always pass the `ICluster` so devnet does not silently target the mainnet program; do not hardcode the program id.
- The constructor signature is `new SolanaStreamClient(clusterUrl, cluster?, commitment?, programId?)`. On protocol failures the client surfaces a `ContractError` carrying a `contractErrorCode`; catch it for structured error codes.

**Success criterion:** A client instance exists and points at the intended cluster with the matching `ICluster`.

### Step 2: Decide vesting vs payment and gather parameters

Collect the schedule and translate every value into SDK units. The two failure modes that bite hardest:

- **Amounts are `BN` in the token's smallest unit.** Never pass a human number. Wrap with `getBN(value, decimals)`, e.g. `getBN(1_000_000, 6)` for 1,000,000 tokens of a 6-decimal mint. Read amounts back with `getNumberFromBN(bn, decimals)`.
- **Timestamps are UNIX seconds, not milliseconds.** Use `Math.floor(Date.now() / 1000)`, never `Date.now()`. A ms value puts your start ~50,000 years in the future.

Map the request to `ICreateStreamData`:

| Field | Meaning |
|-------|---------|
| `recipient` | recipient wallet pubkey (base58 string) |
| `tokenId` | SPL mint address of the token to stream |
| `start` | UNIX seconds when unlock begins |
| `amount` | total locked, `getBN(total, decimals)` |
| `period` | seconds between unlock steps (e.g. `2592000` for 30 days) |
| `cliff` | UNIX seconds when the cliff amount unlocks |
| `cliffAmount` | `BN` released at the cliff (use `getBN(0, decimals)` for none) |
| `amountPerPeriod` | `getBN(perStep, decimals)` released each `period` |
| `name` | human label stored on chain |
| `canTopup` | `false` = vesting (fixed), `true` = streaming payment (refillable) |
| `cancelableBySender` / `cancelableByRecipient` | who may cancel |
| `transferableBySender` / `transferableByRecipient` | who may transfer the recipient role |
| `canUpdateRate` | allow `update` to change the rate later |
| `automaticWithdrawal` | protocol auto-pushes unlocked funds to the recipient |
| `withdrawalFrequency` | seconds between auto-withdrawals, REQUIRED if `automaticWithdrawal` is true |
| `partner` | optional partner pubkey for fee sharing |

- The schedule must be self-consistent: `cliffAmount + (number_of_periods * amountPerPeriod)` should equal `amount`, where `number_of_periods` covers the span from `cliff` to the end. If it does not add up the stream either over- or under-allocates. Compute `amountPerPeriod` and any rounding remainder deliberately.
- `automaticWithdrawal: true` is convenient (the recipient never has to call `withdraw`) but adds an upfront fee (see Step 5).

**Success criterion:** Every amount is a `getBN(...)` value, every timestamp is UNIX seconds, `canTopup` reflects vesting-vs-payment, and the cliff plus per-period math sums to the total.

### Step 3: Create the stream

```ts
import { getBN } from "@streamflow/stream";

const { ixs, txId, metadataId } = await client.create(
  {
    recipient: "RECIPIENT_PUBKEY",
    tokenId: "MINT_PUBKEY",
    start: Math.floor(Date.now() / 1000) + 60,
    amount: getBN(1_000_000, 6),
    period: 2592000,            // 30 days
    cliff: Math.floor(Date.now() / 1000) + 60,
    cliffAmount: getBN(0, 6),
    amountPerPeriod: getBN(41_666, 6),
    name: "Team vesting",
    canTopup: false,            // vesting
    cancelableBySender: true,
    cancelableByRecipient: false,
    transferableBySender: false,
    transferableByRecipient: true,
    automaticWithdrawal: false,
    // withdrawalFrequency: 0,  // only set when automaticWithdrawal is true
  },
  {
    sender: senderKeypairOrWallet, // signer; a Keypair or wallet adapter
    isNative: false,               // set true to wrap/unwrap native SOL
  }
);
// metadataId is the new stream's id (the metadata account pubkey). Persist it.
```

- `create(data, { sender, isNative })` returns `{ ixs, txId, metadataId }`. The stream **id** is `metadataId` (the metadata account pubkey); save it, every later call needs it. `txId` is the confirmed transaction signature.
- Set `isNative: true` only when streaming native SOL (the SDK wraps to wSOL and unwraps on withdraw). For any SPL token leave it `false`.
- The **sender pays**: the 0.25% protocol fee on the total, plus rent for the metadata account, the escrow token account, and the recipient ATA if it does not exist yet. Fund the sender accordingly.

**Success criterion:** `create` resolves, you captured the stream id from `metadataId`, and the transaction confirmed.

### Step 4: Manage the stream (withdraw, cancel, transfer, topup, update)

Every management call takes the stream `id` and an invoker signer. See `resources/api.md` for full signatures.

```ts
import { getBN } from "@streamflow/stream";

// Recipient withdraws a specific amount, or omit `amount` to drain all available:
await client.withdraw({ id, amount: getBN(500, 6) }, { invoker: recipient });
await client.withdraw({ id }, { invoker: recipient }); // all currently unlocked

// Cancel; remaining locked funds return per the cancelable flags:
await client.cancel({ id }, { invoker: sender });

// Hand the recipient role to a new wallet:
await client.transfer({ id, newRecipient: "NEW_PUBKEY" }, { invoker: recipient });

// Add funds (ONLY if the stream was created with canTopup: true):
await client.topup({ id, amount: getBN(100_000, 6) }, { invoker: sender });
```

- `withdraw` succeeds for at most the currently-unlocked amount. Requesting more than unlocked fails: query `getOne` first, or omit `amount` (it is optional) to drain everything available.
- `cancel` is only permitted for an invoker the stream marked cancelable (`cancelableBySender` / `cancelableByRecipient`). The unvested remainder routes back to the sender; already-unlocked funds go to the recipient.
- `topup` fails on a stream created with `canTopup: false`. That is the structural difference between vesting and a streaming payment.

**Success criterion:** The chosen management call resolves and the on-chain stream reflects the change.

### Step 5: Account for fees and rent

- **0.25% protocol fee** is taken from the total at creation, so a vesting stream can deliver at most ~99.75% of `amount` to the recipient. If the recipient must receive an exact net, gross up the `amount`.
- **`automaticWithdrawal: true` adds an upfront ~0.19 SOL fee** on top of the protocol fee. Budget for it or leave auto-withdrawal off and let the recipient call `withdraw`.
- The sender also pays SOL **rent** for the metadata account, the escrow token account, and the recipient's ATA (if it must be created).

**Success criterion:** The sender wallet holds enough SOL and tokens to cover the protocol fee, optional auto-withdraw fee, and all rents before `create` is sent.

### Step 6: Query streams

```ts
import { StreamType, StreamDirection } from "@streamflow/stream";

const one = await client.getOne({ id });

const mine = await client.get({
  address: "SENDER_OR_RECIPIENT_PUBKEY",
  type: StreamType.All,                  // All | Vesting | Lock
  direction: StreamDirection.Outgoing,   // Outgoing | Incoming | All
});
```

- `getOne` returns a single stream by id. `get` lists a wallet's streams as `[id, Stream][]` tuples, filtered by `StreamType` and `StreamDirection`. The `StreamType` enum is `All | Vesting | Lock` (there is no `Payment` member; vesting vs payment is the `canTopup` flag, not a stream type).
- Convert any amount fields back to human units with `getNumberFromBN(bn, decimals)`.

**Success criterion:** You can read a single stream and list a wallet's streams, with amounts converted out of `BN`.

## Examples

### Example 1: Two-year team vesting with a six-month cliff

User asks: "Vest 1,000,000 of my token (6 decimals) to a teammate over 24 months, 6 month cliff, I want to be able to cancel."

The agent:

1. Picks **vesting** (`canTopup: false`), `cancelableBySender: true`.
2. Computes UNIX-seconds timestamps: `start = now`, `cliff = now + 6 months`. After the cliff, 18 monthly periods remain.
3. Splits the total: cliff releases 6/24 = 250,000 tokens at the cliff (`cliffAmount = getBN(250_000, 6)`), the remaining 750,000 unlock over 18 monthly periods at `amountPerPeriod = getBN(41_666.66..., 6)` (handle the rounding remainder so the periods sum to 750,000), `period = 2592000`.
4. Calls `create` with `{ sender, isNative: false }`, persists `metadataId` (the stream id).
5. Tells the user the recipient receives at most ~997,500 net after the 0.25% protocol fee, and the sender paid the rents.

`examples/create-vesting.ts` runs this end to end.

### Example 2: Recipient withdraws, then sender cancels

User asks: "The recipient wants to pull what has vested, and later I want to cancel and get the rest back."

The agent:

1. Reads `getOne({ id })` to see the unlocked amount, converts with `getNumberFromBN`.
2. `withdraw({ id, amount }, { invoker: recipient })` for the available amount.
3. When the user cancels: `cancel({ id }, { invoker: sender })`. Because the stream was created `cancelableBySender: true`, the still-locked remainder returns to the sender; anything already unlocked stays with the recipient.

`examples/withdraw-cancel.ts` runs this flow.

### Example 3: Monthly USDC salary stream

User asks: "Pay a contributor 2,000 USDC per month, and let me add more later."

The agent picks a **streaming payment** (`canTopup: true`), `tokenId` = the USDC mint, `amountPerPeriod = getBN(2000, 6)`, `period = 2592000`, no cliff (`cliffAmount = getBN(0, 6)`), optionally `automaticWithdrawal: true` with `withdrawalFrequency` so the contributor is paid without calling `withdraw` (and budgets the extra ~0.19 SOL fee). Later refills use `topup`.

## Guidelines

- **DO** wrap every amount with `getBN(value, decimals)` and read every amount back with `getNumberFromBN(bn, decimals)`. Raw numbers are always wrong.
- **DO** use UNIX **seconds** for `start`, `cliff`, and `withdrawalFrequency`. Use `Math.floor(Date.now()/1000)`, never `Date.now()`.
- **DO** persist the stream **id** (`metadataId`, the metadata account pubkey) returned by `create`. Every later call needs it.
- **DO** make `cliffAmount + sum(amountPerPeriod over all periods)` equal `amount`, accounting for rounding.
- **DO** set `canTopup: false` for vesting (fixed total) and `true` for streaming payments (refillable). This determines whether `topup` works.
- **DO** set `withdrawalFrequency` whenever `automaticWithdrawal: true`; it is required.
- **DO** fund the sender for the 0.25% protocol fee, the rents, and (if auto-withdraw) the ~0.19 SOL fee before creating.
- **DO** set `isNative: true` only when streaming native SOL, so the SDK wraps/unwraps wSOL.
- **DON'T** hardcode the program id. Let the SDK pick it from the cluster you pass.
- **DON'T** request a `withdraw` larger than the currently unlocked amount; check `getOne` first.
- **DON'T** assume the recipient receives 100% of `amount`; the protocol fee makes it ~99.75%.
- **DO** pass `tokenProgramId` set to the Token-2022 program id when `tokenId` is a Token-2022 mint; it defaults to the classic SPL Token program otherwise.

## Common Errors

### Error: amounts off by `10^decimals` or wildly wrong

**Cause:** Passing a human number instead of a `BN` in smallest units (e.g. `amount: 1000000` instead of `getBN(1_000_000, 6)`).
**Solution:** Wrap every amount with `getBN(value, decimals)` and read back with `getNumberFromBN`.

### Error: stream starts ~50,000 years in the future / never unlocks

**Cause:** A timestamp passed in **milliseconds**. `start`/`cliff` are UNIX **seconds**.
**Solution:** Use `Math.floor(Date.now() / 1000)` for all timestamps.

### Error: `create` fails when `automaticWithdrawal` is true

**Cause:** `withdrawalFrequency` was omitted. It is required whenever `automaticWithdrawal: true`.
**Solution:** Set `withdrawalFrequency` to the auto-withdraw interval in seconds, and budget the extra ~0.19 SOL fee.

### Error: `topup` rejected

**Cause:** The stream was created with `canTopup: false` (a fixed vesting stream).
**Solution:** Only `topup` streaming payments created with `canTopup: true`. Vesting totals are fixed at creation.

### Error: `cancel` rejected for the caller

**Cause:** The invoker is not allowed to cancel; the stream was not created `cancelableBySender`/`cancelableByRecipient` for that party.
**Solution:** Cancel only with an invoker the stream marked cancelable. The flags are immutable after creation.

### Error: `withdraw` reverts on too-large amount

**Cause:** Requested more than the currently-unlocked balance.
**Solution:** Read `getOne({ id })` to find the unlocked amount, or use the SDK's max-amount convention to drain only what is available.

### Error: insufficient funds at creation despite holding the tokens

**Cause:** The sender lacks SOL for the rents (metadata, escrow token account, recipient ATA) or the 0.25% fee was not anticipated.
**Solution:** Fund the sender wallet with enough SOL for all rents plus the protocol fee (and the ~0.19 SOL fee if auto-withdraw is on).

### Error: cluster/program mismatch (`AccountNotFound`, wrong program)

**Cause:** Client cluster URL and `cluster` enum point at different networks, or a hardcoded program id.
**Solution:** Use one cluster consistently and let the SDK choose the program id from the `cluster`. See `resources/addresses.md`.

## References

- `resources/addresses.md` - mainnet and devnet program ids, the 0.25% protocol fee, the auto-withdraw ~0.19 SOL fee, and rent payer notes.
- `resources/api.md` - full method signatures (`create`, `createMultiple`, `withdraw`, `cancel`, `transfer`, `topup`, `update`, `getOne`, `get`), the `ICreateStreamData` fields, the `getBN`/`getNumberFromBN` helpers, and the `StreamType`/`StreamDirection`/`ICluster` enums.
- `examples/create-vesting.ts` - full create flow for a vesting stream with a cliff, runnable with `@streamflow/stream`.
- `examples/withdraw-cancel.ts` - withdraw the unlocked amount, then cancel and return the remainder.
- Streamflow JS SDK on npm: https://www.npmjs.com/package/@streamflow/stream
- Streamflow docs: https://docs.streamflow.finance
- Streamflow JS SDK source: https://github.com/streamflow-finance/js-sdk
