---
name: yellowstone-grpc-stream
description: Subscribe to real-time Solana data (account updates, transaction stream, slots, blocks) over a Yellowstone Geyser gRPC connection, with low latency and provider-agnostic auth. Use when you need a long-lived push stream of on-chain changes instead of polling RPC: tracking a program's accounts as they mutate, watching every transaction that mentions an address, mirroring slot/block progression, or feeding an indexer. Provider-agnostic: the same client speaks to Triton, Helius LaserStream, QuickNode Yellowstone, or a self-hosted Geyser plugin by swapping endpoint and token. Keywords: Yellowstone, Geyser, gRPC, real-time, subscribe, account updates, transaction stream, SubscribeRequest, commitment, accountInclude, memcmp, low latency, push stream, reconnect, backpressure.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Yellowstone Geyser gRPC Stream

Open a long-lived gRPC stream to a Yellowstone Geyser endpoint and receive Solana account, transaction, slot, and block updates the moment they happen, instead of polling RPC. This skill is the subscribe ACTION: how to build a `SubscribeRequest`, read tagged `SubscribeUpdate` messages off a bidirectional stream, set filters and commitment server-side, and survive disconnects. It is provider-agnostic; pick a provider's endpoint and token from a config skill (`helius`, `quicknode`) or your own Geyser node, then drive it with the patterns here.

## Overview

Yellowstone gRPC (the Triton-published Geyser plugin and its protobuf spec) turns the validator's account-update firehose into a filtered push stream over HTTP/2. You connect once, send one `SubscribeRequest` describing exactly what you want, and the server streams matching updates until you disconnect. Compared to `accountSubscribe` / `logsSubscribe` over JSON-RPC WebSocket, it offers richer server-side filtering (by owner program, by `memcmp` on raw account bytes, by required/included/excluded accounts on transactions), lower latency, and one connection for many filters.

The shape is always the same:

1. Construct a client with `endpoint` and an auth `xToken`.
2. `await client.subscribe()` to get a duplex stream.
3. `stream.write(subscribeRequest)` to declare filters + commitment.
4. Read `SubscribeUpdate` messages off the stream; each is tagged by type (`account`, `transaction`, `slot`, `block`, `blockMeta`, `ping`, `pong`).
5. Keep the connection alive with periodic pings; on disconnect, reconnect and resubscribe (resume from the last processed slot when the provider supports `fromSlot`).

This is NOT request/response. The stream is long-lived. Treat it like a socket: filters are evaluated on the server, broad filters are expensive and may be throttled, and you own backpressure and reconnection.

> Version note: the client is published as `@triton-one/yellowstone-grpc` on npm. Proto field casing on `SubscribeRequest` can differ between releases, so if a specific field is rejected, check the installed package's generated types in `node_modules`. The field names below follow the current TypeScript client.

## Instructions

Follow these steps to build a working subscription. Each step states its success criterion.

### Step 1: Get an endpoint and token

Yellowstone gRPC needs a provider gRPC URL and an auth token. These are provider-specific:

- **QuickNode**: derive the gRPC URL from the HTTP endpoint by switching to port `10000` (e.g. `https://name.solana-mainnet.quiknode.pro:10000`); the token is the path segment from the HTTP URL. Requires the Yellowstone add-on enabled.
- **Helius (LaserStream)**: use the LaserStream gRPC endpoint and your Helius API key as the token. Requires a plan that includes LaserStream.
- **Triton**: use the Triton-issued gRPC endpoint and token.
- **Self-hosted**: the `host:port` your Geyser plugin listens on; the token is whatever your plugin config requires (may be empty).

The auth token is sent as the `x-token` gRPC metadata header. Never hardcode it; read from an environment variable.

**Success criterion:** you have `GRPC_ENDPOINT` and `GRPC_TOKEN` in env, and you know the target commitment and what you want to stream.

### Step 2: Construct the client

```ts
import Client from "@triton-one/yellowstone-grpc";

const client = new Client(
  process.env.GRPC_ENDPOINT!, // provider gRPC URL
  process.env.GRPC_TOKEN!,    // auth token, sent as x-token
  undefined,                  // optional channel options (compression, message size)
);
```

The third argument is gRPC channel options (e.g. raise `grpc.max_receive_message_length` for block streams, enable compression). Pass `undefined` for defaults.

**Success criterion:** the client is constructed without throwing. Construction does not open the stream yet.

### Step 3: Open the stream and send a SubscribeRequest

```ts
const stream = await client.subscribe();

const request = {
  accounts: {},          // map of named account filters
  transactions: {},      // map of named transaction filters
  slots: {},
  blocks: {},
  blocksMeta: {},
  entry: {},
  transactionsStatus: {},
  accountsDataSlice: [],  // optional [{ offset, length }] to trim account data
  commitment: CommitmentLevel.CONFIRMED,
};

await new Promise<void>((resolve, reject) => {
  stream.write(request, (err: unknown) => (err ? reject(err) : resolve()));
});
```

Each filter group is a **map** from a name you choose (used to tag updates so you know which filter matched) to a filter object. Leave groups you do not want as empty maps. See `resources/subscribe-request.md` for every field. You can `write` a new request later to change filters without reconnecting.

**Success criterion:** `subscribe()` resolves and the `write` callback fires with no error.

### Step 4: Read updates and tag them by type

```ts
stream.on("data", (update) => {
  if (update.account)     { /* SubscribeUpdateAccount */ }
  if (update.transaction) { /* SubscribeUpdateTransaction */ }
  if (update.slot)        { /* SubscribeUpdateSlot */ }
  if (update.block)       { /* SubscribeUpdateBlock */ }
  if (update.blockMeta)   { /* SubscribeUpdateBlockMeta */ }
  if (update.ping)        { /* server asked for a pong, see Step 5 */ }
  if (update.pong)        { /* reply to our ping */ }
});
stream.on("error", (e) => { /* reconnect, see Step 6 */ });
stream.on("end", () => { /* server closed, reconnect */ });
```

Exactly one payload field is set per `SubscribeUpdate`. The `filters` array on each update tells you which named filter(s) matched. Pubkeys and signatures arrive as raw bytes (`Uint8Array`/`Buffer`); base58-encode them for display with `bs58`.

**Success criterion:** you receive at least one update (or a `ping`) and can route it by type.

### Step 5: Keep the connection alive

Long-lived gRPC streams idle out. Send a periodic ping by writing a request whose body is empty except `ping: { id }`:

```ts
setInterval(() => {
  stream.write({ accounts: {}, transactions: {}, slots: {}, blocks: {},
    blocksMeta: {}, entry: {}, transactionsStatus: {}, accountsDataSlice: [],
    ping: { id: 1 } });
}, 10_000);
```

Also respond to server `ping` updates if your provider requires it. Use ~10s intervals; do not spam.

**Success criterion:** the stream stays open with no traffic for longer than the provider idle timeout.

### Step 6: Handle disconnects and resume

Wrap the whole connect-subscribe-read flow in a function and call it again on `error`/`end` with exponential backoff. Track the last processed slot; on reconnect, if the provider supports it, set `fromSlot` on the request to replay from there and avoid gaps.

**Success criterion:** killing the network mid-stream leads to an automatic reconnect and resubscribe, not a crashed process.

## Examples

### Example: stream every account owned by a program (with reconnect)

When the user asks: "Stream live updates for all accounts owned by program `<PUBKEY>`."

The agent should subscribe with an `accounts` filter keyed by `owner`, commitment `CONFIRMED`, decode pubkeys with `bs58`, and reconnect on disconnect. `examples/subscribe-accounts.ts` is the complete runnable version: it owner-filters, optionally adds a `datasize` / `memcmp` filter, pings every 10s, and reconnects with backoff.

```ts
const request = {
  accounts: {
    byOwner: {
      account: [],
      owner: [PROGRAM_ID],   // base58 strings
      filters: [],            // add { datasize } or { memcmp: { offset, base58 } } to narrow
    },
  },
  transactions: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
  transactionsStatus: {}, accountsDataSlice: [],
  commitment: CommitmentLevel.CONFIRMED,
};
```

### Example: stream every transaction that mentions an account

When the user asks: "Notify me of every transaction touching wallet/program `<PUBKEY>`."

Use a `transactions` filter with `accountInclude: [PUBKEY]`, `vote: false`, `failed: false`. `examples/subscribe-transactions.ts` runs this end to end and base58-encodes the signature for each match.

```ts
const request = {
  transactions: {
    mentionsAccount: {
      vote: false,
      failed: false,
      accountInclude: [TARGET],  // tx must reference at least one of these
      accountExclude: [],
      accountRequired: [],       // tx must reference ALL of these (stricter)
    },
  },
  accounts: {}, slots: {}, blocks: {}, blocksMeta: {}, entry: {},
  transactionsStatus: {}, accountsDataSlice: [],
  commitment: CommitmentLevel.CONFIRMED,
};
```

## Guidelines

- **DO** make filters as narrow as possible. `accountInclude` with specific pubkeys or an `owner` + `memcmp` filter is cheap; an empty/overly-broad filter streams the firehose and gets throttled or disconnected.
- **DO** name each filter (the map key) so you can tell which filter a `SubscribeUpdate` matched via its `filters` array.
- **DO** send periodic pings (~10s) and reconnect with exponential backoff. The stream is long-lived; idle connections are dropped.
- **DO** track the last processed slot and resume with `fromSlot` after a reconnect when the provider supports it, to avoid gaps.
- **DO** base58-encode the raw `Uint8Array` pubkeys and signatures before logging or comparing them.
- **DO** set commitment deliberately: `PROCESSED` for lowest latency (may be rolled back), `CONFIRMED` for most uses, `FINALIZED` for irreversibility.
- **DO** use `accountsDataSlice` to fetch only the bytes you need when you do not want full account data.
- **DON'T** treat the stream as request/response. One `SubscribeRequest` configures an ongoing push; there is no per-message reply.
- **DON'T** put the token in source. Read `x-token` from the environment.
- **DON'T** assume `accountInclude` and `accountRequired` mean the same thing: `Include` matches if ANY listed account appears; `Required` matches only if ALL listed accounts appear.
- **DON'T** build `memcmp` offsets by guessing. They match the raw on-chain account layout; an offset into the wrong field silently matches nothing.

## Common Errors

### Error: stream connects but no updates ever arrive
**Cause**: the filter is too narrow, points at the wrong program/account, a `memcmp` offset is wrong, or commitment is `FINALIZED` on a low-traffic account. Empty filter maps with no group set also yield nothing.
**Solution**: widen temporarily (e.g. subscribe to `slots: { all: {} }` to confirm the pipe works), verify the pubkey is base58 and correct, recheck the `memcmp` offset against the real account layout, and lower commitment to `CONFIRMED`/`PROCESSED` while testing.

### Error: `Unauthenticated` / 16 / missing x-token
**Cause**: wrong or missing auth token, or the token is not being sent as the `x-token` metadata header.
**Solution**: pass the provider token as the second constructor argument so it is sent as `x-token`. Confirm the token matches the provider/plan (QuickNode add-on enabled, Helius LaserStream plan, etc.).

### Error: stream drops after seconds/minutes of silence
**Cause**: idle gRPC connections are closed by the provider or intermediaries; no keepalive.
**Solution**: send a `ping: { id }` request every ~10s, and reply to server `ping` updates. Reconnect on `error`/`end` with backoff.

### Error: `RESOURCE_EXHAUSTED` / throttled / repeated disconnects
**Cause**: filter is too broad (whole-firehose accounts/transactions), exceeding the plan's allowed data rate.
**Solution**: narrow to specific `owner`/`accountInclude` values, add `memcmp`/`datasize`, use `accountsDataSlice`, or split work across connections within plan limits.

### Error: `RESOURCE_EXHAUSTED: received message larger than max` on block streams
**Cause**: full `blocks` updates exceed the default gRPC max receive message size.
**Solution**: raise `grpc.max_receive_message_length` in the client channel options, or stream `blocksMeta` / narrower filters instead of full blocks.

### Error: pubkeys/signatures look like byte arrays, comparisons fail
**Cause**: the proto delivers pubkeys and signatures as raw bytes, not base58 strings.
**Solution**: base58-encode with `bs58.encode(bytes)` before display or comparison; do not string-compare a `Buffer` to a base58 string.

### Error: a field on `SubscribeRequest` is rejected or ignored
**Cause**: field name casing differs from the installed package's generated types (proto releases vary).
**Solution**: open the package's TypeScript types in `node_modules` and match the exact field names.

## References

- `resources/subscribe-request.md` - the full `SubscribeRequest` shape: account/transaction/slot/block filters, the account data filters (`memcmp`, `datasize`, `token_account_state`, `lamports`), commitment levels, `accountsDataSlice`, `fromSlot`, ping, and a provider-endpoint note (Triton / Helius LaserStream / QuickNode / self-hosted).
- `examples/subscribe-accounts.ts` - subscribe to all accounts owned by a program with commitment, optional `memcmp`/`datasize`, keepalive ping, and reconnect-with-backoff. Runnable with the Yellowstone gRPC client + `bs58`.
- `examples/subscribe-transactions.ts` - stream transactions that mention a target account (`accountInclude`), base58-encode the signature, with the same keepalive + reconnect harness.
- Yellowstone gRPC (Triton) repo and protobuf spec: https://github.com/rpcpool/yellowstone-grpc
- npm client: https://www.npmjs.com/package/@triton-one/yellowstone-grpc
- QuickNode Yellowstone gRPC docs: https://www.quicknode.com/docs/solana/yellowstone-grpc/overview
- Helius LaserStream docs: https://www.helius.dev/docs/data-streaming/laserstream
- Solana account/commitment background: https://solana.com/docs/rpc#configuring-state-commitment
