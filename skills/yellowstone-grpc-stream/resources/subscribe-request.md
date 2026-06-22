# SubscribeRequest reference

The single `SubscribeRequest` you write to the stream declares everything the server should push. It is a set of filter maps plus global options. Each filter group is a **map** from a name you choose to a filter object; the name is echoed back in each update's `filters` array so you know which filter matched. Leave groups you do not want as empty maps `{}`.

> Field names below follow the `@triton-one/yellowstone-grpc` TypeScript client. Proto field casing can change between releases; if a specific field is rejected, match it against the generated types in `node_modules`.

## Top-level shape

```ts
interface SubscribeRequest {
  accounts: Record<string, SubscribeRequestFilterAccounts>;
  transactions: Record<string, SubscribeRequestFilterTransactions>;
  transactionsStatus: Record<string, SubscribeRequestFilterTransactions>; // lightweight status, same filter shape
  slots: Record<string, SubscribeRequestFilterSlots>;
  blocks: Record<string, SubscribeRequestFilterBlocks>;
  blocksMeta: Record<string, SubscribeRequestFilterBlocksMeta>;
  entry: Record<string, SubscribeRequestFilterEntry>;
  accountsDataSlice: { offset: string; length: string }[]; // trim returned account data
  commitment?: CommitmentLevel;
  ping?: { id: number };       // keepalive
  fromSlot?: string;           // optional replay start slot (provider-dependent)
}
```

## Commitment levels

| Level | Enum (typical) | Meaning | Use when |
|-------|----------------|---------|----------|
| Processed | `CommitmentLevel.PROCESSED` (0) | Most recent, may be rolled back | Lowest latency, you can tolerate forks |
| Confirmed | `CommitmentLevel.CONFIRMED` (1) | Voted on by supermajority | Default for most apps |
| Finalized | `CommitmentLevel.FINALIZED` (2) | Rooted, irreversible | Settlement, accounting, anything you cannot undo |

Set commitment once per request; it applies to the whole subscription.

## Account filter (`SubscribeRequestFilterAccounts`)

```ts
interface SubscribeRequestFilterAccounts {
  account: string[];   // specific account pubkeys (base58)
  owner: string[];     // owner program pubkeys (base58); stream all accounts a program owns
  filters: SubscribeRequestFilterAccountsFilter[]; // data filters, ANDed together
  nonemptyTxnSignature?: boolean; // only updates carrying a non-empty tx signature
}
```

- `account` and `owner` are ORed within the filter (an account matches if it is in `account` OR owned by something in `owner`), then `filters` are ANDed on top.
- An empty filter (`account: []`, `owner: []`, `filters: []`) matches ALL accounts. Avoid it on mainnet; it is the firehose.

### Account data filters (`filters[]`)

| Filter | Shape | Matches |
|--------|-------|---------|
| `memcmp` | `{ memcmp: { offset, base58 } }` (or `bytes` / `base64`) | Accounts whose raw data equals the given bytes at `offset` |
| `datasize` | `{ datasize: <number> }` | Accounts whose data length equals the value exactly |
| `tokenAccountState` | `{ tokenAccountState: true }` | Valid SPL token account state |
| `lamports` | `{ lamports: { eq | ne | lt | gt: <value> } }` | Accounts whose lamport balance compares as specified |

`memcmp.offset` is a byte offset into the **raw on-chain account layout**, not a parsed field index. For Anchor accounts remember the 8-byte discriminator prefix. A wrong offset silently matches nothing.

## Transaction filter (`SubscribeRequestFilterTransactions`)

```ts
interface SubscribeRequestFilterTransactions {
  vote?: boolean;          // include (true) / exclude (false) vote txs; omit for both
  failed?: boolean;        // include (true) / exclude (false) failed txs; omit for both
  signature?: string;      // a single specific signature
  accountInclude: string[]; // tx must reference AT LEAST ONE of these
  accountExclude: string[]; // tx must reference NONE of these
  accountRequired: string[];// tx must reference ALL of these
}
```

- `accountInclude` = ANY match; `accountRequired` = ALL match; `accountExclude` = reject if present. They combine.
- Set `vote: false, failed: false` to skip vote noise and failed transactions in most monitoring use cases.
- `transactionsStatus` uses the same filter shape but yields lightweight status-only updates (no full transaction body).

## Slot / block / entry filters

```ts
interface SubscribeRequestFilterSlots { filterByCommitment?: boolean; interslotUpdates?: boolean; }
interface SubscribeRequestFilterBlocks {
  accountInclude: string[];
  includeTransactions?: boolean;
  includeAccounts?: boolean;
  includeEntries?: boolean;
}
interface SubscribeRequestFilterBlocksMeta {} // block metadata only, no contents
interface SubscribeRequestFilterEntry {}      // PoH entries
```

- `slots: { all: {} }` is the cheapest way to verify the pipe is alive while debugging filters.
- Full `blocks` updates are large; they often need a raised `grpc.max_receive_message_length` channel option. Prefer `blocksMeta` when you only need headers.

## accountsDataSlice

`accountsDataSlice: [{ offset, length }]` returns only that byte window of each account's data, reducing bandwidth when you do not need the full account.

## fromSlot (replay / resume)

When supported by the provider, set `fromSlot` to a slot number to replay from there on (re)subscribe. Track the last processed slot and resume from it after a reconnect to avoid gaps. Not all providers/plans support replay; if unsupported, the field is ignored and you resume live.

## Updates you receive (`SubscribeUpdate`)

Exactly one payload field is set per message, plus a `filters: string[]` naming which of your filters matched:

| Field | Payload |
|-------|---------|
| `account` | `SubscribeUpdateAccount`: pubkey, owner, lamports, data, slot, writeVersion |
| `transaction` | `SubscribeUpdateTransaction`: signature, full tx + meta, slot |
| `transactionStatus` | lightweight status (signature, slot, err) |
| `slot` | slot number + parent + status |
| `block` | full block (transactions/accounts/entries per filter) |
| `blockMeta` | block header/metadata |
| `entry` | PoH entry |
| `ping` | server keepalive request; reply with a ping write if required |
| `pong` | reply to your ping |

Pubkeys and signatures arrive as raw bytes. Base58-encode them (`bs58.encode(bytes)`) before logging or comparing.

## Provider endpoints (provider-agnostic auth)

The same client speaks to any Yellowstone Geyser endpoint; only the endpoint URL and token change. The token is sent as the `x-token` gRPC metadata header.

| Provider | Endpoint | Token | Notes |
|----------|----------|-------|-------|
| QuickNode | HTTP endpoint with port `:10000` (e.g. `https://name.solana-mainnet.quiknode.pro:10000`) | path segment from the HTTP URL | Enable the Yellowstone gRPC add-on |
| Helius (LaserStream) | LaserStream gRPC endpoint | Helius API key | Requires a plan that includes LaserStream |
| Triton | Triton-issued gRPC endpoint | Triton-issued token | The reference implementation |
| Self-hosted | your Geyser plugin `host:port` | per your plugin config (may be empty) | Run the Yellowstone Geyser plugin on a validator |

Always read endpoint and token from environment variables. Never commit the token.
