# Tensor REST API reference

The recommended surface for agents. Every trading endpoint returns a fully built transaction; the client supplies a blockhash, signs locally, and submits via its own RPC.

## Base URL and status

- Base URL: `https://api.mainnet.tensordev.io/api/v1`
- Status: **ALPHA.** Breaking changes are possible. Field names can shift. Code defensively, optional-chain every field, and never hard-fail because one optional field is absent.
- Developer Hub: `https://dev.tensor.trade` (the old `docs.tensor.so` is dead).
- AI index for cross-checking the live shape: `https://dev.tensor.trade/llms.txt`

## Authentication

Send the API key on every request in this header, spelled exactly (lowercase, hyphenated):

```
x-tensor-api-key: <YOUR_KEY>
```

The key is **gated**: there is no self-serve dashboard. Apply through the Airtable form linked from `https://dev.tensor.trade`. The cost is not publicly stated. Read the key from an environment variable; never hardcode or commit it.

Published rate limits do **not** exist. Build exponential backoff with jitter; treat `429` and `5xx` as transient.

## Transaction-building endpoints (`/tx/*`)

All `/tx/*` endpoints are **GET** with query-string params. All take a recent `blockhash` supplied by the caller. All return a `TxResponseRest` (see below). Amounts are in **lamports** (1 SOL = 1,000,000,000 lamports).

| Endpoint | Required params | Optional params | Returns | Sign with |
|----------|-----------------|-----------------|---------|-----------|
| `GET /tx/buy` | `buyer`, `mint`, `owner`, `maxPrice`, `blockhash` | `currency`, `takerBroker`, `priorityMicroLamports`, `includeTotalCost` | tx | taker (buyer) |
| `GET /tx/list` | `mint`, `owner`, `price`, `blockhash` | `expireIn`, `makerBroker` | tx | maker (seller) |
| `GET /tx/sell` | `seller`, `mint`, `bidAddress`, `minPrice`, `blockhash` | | tx | taker (seller) |
| `GET /tx/collection_bid` | `owner`, `price`, `quantity`, `collId`, `blockhash` | | tx + `bidState` | maker (bidder) |
| `GET /tx/trait_bid` | `owner`, `price`, `quantity`, `collId`, `blockhash`, `traits[]` | | tx + `bidState` | maker (bidder) |
| `GET /tx/bid` | single-mint bid (mint-scoped variant of the above) | | tx + `bidState` | maker (bidder) |
| `GET /tx/edit` | edit an existing listing or bid | | tx | owner |
| `GET /tx/delist` | cancel a listing (or a bid) | | tx | owner |

Notes on key params:

- **`owner` on `/tx/buy`** is the *current listing owner* (the seller you are buying from), taken from the floor/listing read. On `/tx/list` and the bid endpoints, `owner` is the maker's own wallet.
- **`maxPrice` (buy) / `minPrice` (sell)** are slippage guards in lamports. Set them off the live floor/quote with a tolerance; never `0` and never an unbounded max.
- **`bidAddress` on `/tx/sell`** is either a bid-state account (the `bidState` returned when a bid was placed) **or** an AMM pool address. Both are valid sell targets.
- **`traits[]` on `/tx/trait_bid`** is an array where each element is a JSON string describing one trait constraint.
- **`blockhash`** must be recent; you confirm the signed tx against this same blockhash and the returned `lastValidBlockHeight`.

### `TxResponseRest` shape

```jsonc
{
  "txs": [
    {
      "txV0": "<base64 versioned transaction to deserialize, sign, send>",
      "tx": { /* optional legacy/raw form */ },
      "lastValidBlockHeight": 123456789,
      "metadata": { /* optional, e.g. total cost when includeTotalCost=true */ }
    }
  ]
}
```

- `txs[0].txV0` is the field you use: base64 -> `VersionedTransaction.deserialize`.
- `lastValidBlockHeight` is what you confirm against.
- Bid endpoints also return a `bidState` address (persist it; it becomes the `bidAddress` to fill or cancel the bid). Treat its exact location as ALPHA-mutable and read it defensively.

## Read endpoints

| Endpoint | Purpose | Key params |
|----------|---------|-----------|
| `GET /mint/active_listings` | List active listings; sort `PriceAsc` + `limit=1` to read the floor (cheapest) | `collId`, `sortBy`, `limit` (1..250) |
| OHLC floor-candles endpoint | Historical floor price candles | collection + interval |
| `GET .../getcollectionbids` | Live collection bids | `collId` |
| `GET .../gettraitbids` | Live trait bids | `collId` |
| `GET .../findcollection` / `searchcollections` | Resolve a slug/name to a `collId` | slug or name |
| `GET .../getcollectiontraits` | Trait values available for a collection (to build trait bids) | `collId` |
| `GET .../getmintproof` | Merkle proof for a cNFT (only needed for SDK paths; REST `/tx/*` does this internally) | `mint` |

The floor read is the backbone: `GET /mint/active_listings?collId=<id>&sortBy=PriceAsc&limit=1`, then read `mint`, `owner`, and `price` from the first entry.

## The deserialize-sign-send flow

```ts
import { Connection, VersionedTransaction } from "@solana/web3.js";

const BASE = "https://api.mainnet.tensordev.io/api/v1";

async function buildSignSend(
  path: string,
  params: Record<string, string>,
  connection: Connection,
  signer: { secretKey: Uint8Array; publicKey: unknown } | any,
  apiKey: string
) {
  // 1. fresh blockhash from your own RPC
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

  // 2. GET the built transaction
  const url = `${BASE}${path}?${new URLSearchParams({ ...params, blockhash })}`;
  const res = await fetch(url, { headers: { "x-tensor-api-key": apiKey } });
  if (!res.ok) throw new Error(`Tensor ${path} -> ${res.status} ${await res.text()}`);
  const body = await res.json();

  // 3. deserialize -> sign -> send
  const tx = VersionedTransaction.deserialize(
    Buffer.from(body.txs[0].txV0, "base64")
  );
  tx.sign([signer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });

  // 4. confirm against the SAME blockhash
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight: body.txs[0].lastValidBlockHeight ?? lastValidBlockHeight },
    "confirmed"
  );

  // 5. bid endpoints return a bidState to persist
  return { sig, bidState: body.txs[0]?.metadata?.bidState ?? body.bidState };
}
```

## Compressed NFTs (cNFTs)

The REST `/tx/buy`, `/tx/list`, and `/tx/sell` endpoints take a plain `mint` and work for **both** regular and compressed NFTs. The API detects compression and fetches the Merkle proof server-side. The agent passes **no** Merkle arguments. (The SDK path is the opposite; see `sdks.md`.)

## Defensive checklist

- Header is exactly `x-tensor-api-key`.
- Key comes from an env var, never committed.
- Amounts in lamports.
- `maxPrice`/`minPrice` set as real slippage guards.
- Backoff with jitter; no published rate limit.
- Optional-chain response fields; tolerate missing optional keys (ALPHA).
- Confirm against the submitted blockhash; on expiry, refetch + rebuild rather than resend.
