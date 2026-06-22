---
name: tensor
description: Trade NFTs on the Tensor marketplace from an agent. Buy at floor, list for sale, sell into a bid, and place collection or trait bids, for both regular and compressed NFTs (cNFTs). Use when a user wants to buy an NFT, list an NFT, sell an NFT, find or hit the floor, place a bid (collection bid, trait bid), cancel a bid, or read live listings and floor prices on Tensor. Keywords: Tensor, NFT marketplace, list NFT, bid, collection bid, trait bid, buy NFT, floor price, compressed NFT trading, cNFT, tensordev API, TensorSwap, tcomp.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Tensor NFT Marketplace

Trade NFTs on Tensor, the dominant Solana NFT marketplace, from inside an agent. This skill covers the full maker/taker loop for regular and compressed NFTs: read the floor, buy, list, sell into a bid, and place or cancel collection and trait bids. It is the missing NFT-marketplace skill: other skills mint and query assets, this one trades them.

## Overview

Tensor exposes two surfaces, and choosing the right one is the most important decision in this skill.

- **(A) REST API** at `https://api.mainnet.tensordev.io/api/v1`. This is the **recommended path for agents.** Every trading endpoint is a `GET` that returns a fully built, ready-to-sign transaction. Critically, the API resolves NFT compression server-side: for a compressed NFT it fetches the Merkle proof for you, so the agent passes only a `mint` and never touches proofs. The agent's job shrinks to: supply a blockhash, receive a transaction, sign it, send it.
- **(B) On-chain SDKs** (`@tensor-foundation/marketplace` and the legacy `@tensor-oss/*` packages). These build instructions client-side with no rate limit, for advanced or high-frequency callers. The cost is that for compressed NFTs **you** must fetch every Merkle field (tree, root, canopy depth, leaf index, proof, data hash, creators hash) yourself from a DAS provider.

Default to the REST API. Reach for an SDK only when the caller explicitly needs client-side instruction building, batching into a custom transaction, or to avoid the gated REST key.

### Two prominent warnings, read before you build

1. **The REST API key is gated.** There is no self-serve dashboard. Access is granted by application through the Airtable form linked from the Tensor Developer Hub at `https://dev.tensor.trade`. The cost is not publicly stated. If the caller does not yet have a key, the correct action is to tell them to apply, not to invent a key. The auth header is **exactly** `x-tensor-api-key` (lowercase, with hyphens).
2. **The REST API is documented as ALPHA.** Breaking changes are possible, field names can shift, and published rate limits do not exist. Build defensively: never hard-fail because one optional field is missing from a response, wrap calls in retry-with-backoff, and treat the endpoint and parameter names below as the current shape rather than a frozen contract. Verify against the live AI index at `https://dev.tensor.trade/llms.txt` when something does not match.

> The old docs host `docs.tensor.so` is dead. `https://dev.tensor.trade` is the current Developer Hub.

### The universal transaction flow (REST)

Every `/tx/*` endpoint follows the same pattern. Internalize this once and all trade actions are the same shape:

1. Resolve the `collId` (collection id) for the collection, if the action needs it, via `findcollection` / `searchcollections`.
2. Fetch a recent blockhash from your own RPC.
3. `GET /tx/<action>` with the `x-tensor-api-key` header, the action params, and that `blockhash`.
4. Read `txs[0].txV0` (base64) from the `TxResponseRest` body and deserialize it into a `VersionedTransaction`.
5. Sign it with the maker or taker wallet.
6. Send the raw transaction via your own RPC and confirm before `lastValidBlockHeight` passes.
7. For bids, persist the returned `bidState` address: you need it later as `bidAddress` to sell into the bid or to cancel it.

The client supplies the blockhash and signs; the client does **not** build instructions. The API never sees a private key.

## Instructions

Follow these steps for any Tensor trade. Each step states its success criterion.

### Step 0: Pick the surface and confirm the key

- If the caller wants a straightforward buy/list/sell/bid, use the **REST API**. If they explicitly want client-side instruction building, batching, or no rate limit, route to `resources/sdks.md`.
- Confirm an API key is available (environment variable, e.g. `TENSOR_API_KEY`). If absent, STOP and tell the caller to apply via the Airtable form on `https://dev.tensor.trade`. Do not fabricate a key.

**Success criterion:** A surface is chosen and, for REST, a real `x-tensor-api-key` value is in hand.

### Step 1: Resolve the collection id (collId) when needed

Floor reads and all bids are keyed by `collId`, not by a human collection name.

- Call `GET /api/v1/collections/findcollection` (or `searchcollections`) with the slug or name to obtain the `collId`.
- A buy or a list of a single, already-known `mint` does **not** need a `collId`. A floor read, a collection bid, and a trait bid all do.

**Success criterion:** You have the exact `collId` string for any collection-scoped action, or you have confirmed the action only needs a `mint`.

### Step 2: Read the floor (for buys and for pricing bids/listings)

- `GET /api/v1/mint/active_listings?collId=<id>&sortBy=PriceAsc&limit=1`. Sorting by price ascending and reading the first entry gives the cheapest active listing, which is the floor.
- The floor listing carries the `mint` and the seller `owner` and the listed `price` (in lamports of the listing currency, usually SOL). You need all three to build a buy.
- For historical floor, use the OHLC floor-candles endpoint. See `resources/rest-endpoints.md`.

**Success criterion:** You have the current floor `mint`, `owner`, and `price`, or a price reference for the bid/listing you are about to place.

### Step 3: Build the action transaction (GET /tx/...)

Call the matching `GET /tx/*` endpoint with the `x-tensor-api-key` header, the action params, and a fresh `blockhash`. The endpoints:

- **Buy:** `GET /tx/buy` with `buyer`, `mint`, `owner` (current listing owner from Step 2), `maxPrice` (slippage cap, in lamports), `blockhash`. Optional: `currency`, `takerBroker`, `priorityMicroLamports`, `includeTotalCost`.
- **List:** `GET /tx/list` with `mint`, `owner` (seller), `price` (in lamports), `blockhash`. Optional: `expireIn`, `makerBroker`.
- **Sell into a bid:** `GET /tx/sell` with `seller`, `mint`, `bidAddress`, `minPrice` (slippage floor), `blockhash`. `bidAddress` is the bid-state account from a bid you are hitting, **or** an AMM pool address.
- **Collection bid:** `GET /tx/collection_bid` with `owner` (bidder), `price` (per item, lamports), `quantity`, `collId`, `blockhash`. Returns a `bidState` address.
- **Trait bid:** `GET /tx/trait_bid` with `owner`, `price`, `quantity`, `collId`, `blockhash`, and `traits[]` where each entry is a JSON string describing one trait constraint. Returns a `bidState`.
- Also available: `GET /tx/edit` (change a listing/bid), `GET /tx/delist` (cancel a listing), `GET /tx/bid` (single-mint bid).

`maxPrice` on buy and `minPrice` on sell are slippage guards: set them with a tolerance off the quoted/floor price so a moving market cannot fill at a worse number than intended.

**Success criterion:** A `200` response with a `TxResponseRest` body whose `txs[0].txV0` is a non-empty base64 string.

### Step 4: Deserialize, sign, send, confirm

```ts
import { VersionedTransaction } from "@solana/web3.js";

const { txs } = await res.json();
const tx = VersionedTransaction.deserialize(Buffer.from(txs[0].txV0, "base64"));
tx.sign([wallet]); // maker for list/bid, taker for buy/sell
const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
await connection.confirmTransaction(
  { signature: sig, blockhash, lastValidBlockHeight: txs[0].lastValidBlockHeight },
  "confirmed"
);
```

The same blockhash you passed into the `GET` is the one you confirm against. If `confirmTransaction` times out past `lastValidBlockHeight`, the transaction was dropped (never landed): fetch a fresh blockhash, re-request the tx, re-sign, resend. Do not blind-retry a transaction that actually reverted on chain.

**Success criterion:** A confirmed signature, or a classified failure (dropped vs reverted) with the right next action.

### Step 5: Persist bid state (for collection/trait/single bids)

When you place any bid, the response includes a `bidState` address. Save it. You need it as `bidAddress` when:
- selling an NFT into that bid (`/tx/sell`), and
- cancelling the bid later (`/tx/delist` / `/tx/edit` on the bid).

Read live bids with `getcollectionbids` and `gettraitbids`.

**Success criterion:** The `bidState` for every placed bid is stored alongside the wallet that owns it.

## Examples

### Example 1: Find the floor and buy it

User input: "Buy the cheapest one from collection `tensorians`."

The agent runs `examples/get-floor-and-buy.ts`:

1. Resolve `collId` for `tensorians` via `findcollection`.
2. `GET /mint/active_listings?collId=<id>&sortBy=PriceAsc&limit=1` -> read floor `mint`, `owner`, `price`.
3. Set `maxPrice = floorPrice` (optionally a few percent over for slippage).
4. Fetch a blockhash. `GET /tx/buy?buyer=<wallet>&mint=<mint>&owner=<owner>&maxPrice=<lamports>&blockhash=<bh>`.
5. Deserialize `txs[0].txV0` -> sign with the buyer wallet -> send -> confirm.

This works identically for a compressed NFT: the same `/tx/buy` call resolves compression and the Merkle proof server-side, so nothing in the agent changes.

### Example 2: List an NFT, then place a collection bid

User input: "List my NFT `<mint>` for 5 SOL, and put a 4 SOL bid on the whole collection."

The agent runs `examples/list-and-bid.ts`:

1. **List:** fetch a blockhash. `GET /tx/list?mint=<mint>&owner=<wallet>&price=5000000000&blockhash=<bh>` -> deserialize -> sign (seller) -> send -> confirm.
2. **Collection bid:** resolve `collId`. Fetch a fresh blockhash. `GET /tx/collection_bid?owner=<wallet>&price=4000000000&quantity=1&collId=<id>&blockhash=<bh>` -> deserialize -> sign (bidder) -> send -> confirm.
3. Save the returned `bidState`; it is the `bidAddress` someone (or you) uses with `/tx/sell` to fill the bid, and what you pass to cancel it.

### Example 3: Sell into an existing bid

User input: "Someone has a 4.2 SOL collection bid `<bidState>` on a collection I hold `<mint>`. Sell into it."

The agent: fetch a blockhash. `GET /tx/sell?seller=<wallet>&mint=<mint>&bidAddress=<bidState>&minPrice=4200000000&blockhash=<bh>` -> deserialize `txs[0].txV0` -> sign (seller) -> send -> confirm. `minPrice` guards against the bid being lowered between quote and execution. `bidAddress` here is a bid-state account; it could equally be an AMM pool address when selling into a pool.

## Guidelines

- **DO** default to the REST API for agent trading. It builds the transaction and, for cNFTs, fetches Merkle proofs server-side. You only sign.
- **DO** use the exact header `x-tensor-api-key` (lowercase, hyphenated). A wrong-case header is the most common auth failure.
- **DO** treat the API as ALPHA: wrap calls in retry-with-backoff, tolerate missing optional fields, and never hard-fail on one absent key in the response.
- **DO** set `maxPrice` on buys and `minPrice` on sells as real slippage guards off the live floor/quote, never `0` or `Number.MAX_SAFE_INTEGER`.
- **DO** pass amounts in **lamports** (1 SOL = 1,000,000,000 lamports), not in SOL.
- **DO** confirm against the `blockhash` you submitted and `txs[0].lastValidBlockHeight`; on timeout, refetch a fresh blockhash and rebuild rather than resending a stale tx.
- **DO** persist the `bidState` returned by every bid; it is required to fill or cancel that bid later.
- **DON'T** hardcode a Tensor API key or commit it. Read it from an environment variable. Apply for it via the Airtable form on `https://dev.tensor.trade` if you do not have one.
- **DON'T** send any private key to the API. The API returns an unsigned transaction; signing happens locally.
- **DON'T** pass Merkle proof arguments for a compressed NFT to the REST endpoints. The API resolves them. (The SDK is the opposite: there you must supply them, see `resources/sdks.md`.)
- **DON'T** hardcode a specific SDK version. The org renamed `tensor-hq` -> `tensor-oss` -> `tensor-foundation`, so versions drift. Pin whatever current version `npm install` resolves at build time.
- **DON'T** reference `docs.tensor.so`; it is dead. Use `https://dev.tensor.trade`.

## Common Errors

### Error: 401 / 403 Unauthorized
**Cause:** Missing key, wrong header name, or an un-granted key. The header must be exactly `x-tensor-api-key`; the key is gated and may not be active.
**Solution:** Verify the header spelling and case. Confirm the key was granted via the Airtable application on `https://dev.tensor.trade`. Do not retry blindly on a 401.

### Error: A response field is missing or the shape changed
**Cause:** The API is ALPHA; field names and shapes can change between releases.
**Solution:** Code defensively (optional-chain every field, no hard-fail on one missing key). Cross-check the current shape against `https://dev.tensor.trade/llms.txt`.

### Error: Transaction expired / never confirmed
**Cause:** The blockhash you submitted to `/tx/*` aged out before the signed tx landed (it was dropped, not reverted).
**Solution:** Fetch a fresh blockhash, re-request the `/tx/*` transaction, re-sign, resend, confirm against the new `lastValidBlockHeight`. Safe to retry only because it never executed.

### Error: Buy filled at a worse price than expected (or reverted on price)
**Cause:** The floor moved between the `active_listings` read and the buy; `maxPrice` was unset or too tight/loose.
**Solution:** Re-read `active_listings`, set `maxPrice` to the live floor plus a small slippage tolerance, rebuild the buy. Do not blind-retry.

### Error: cNFT trade fails with a Merkle/proof error when using the SDK
**Cause:** With `@tensor-oss/tcomp-sdk` you must supply the Merkle fields yourself (tree, root, canopy depth, leaf index, proof, data hash, creators hash); a stale or missing proof fails.
**Solution:** Refetch the DAS asset + proof immediately before building, or switch to the REST API which resolves proofs server-side.

### Error: Unknown rate limit / sudden throttling
**Cause:** Tensor does not publish REST rate limits.
**Solution:** Build exponential backoff with jitter and a request cap. Treat 429/5xx as transient and back off; do not hammer.

## References

- `resources/rest-endpoints.md` - the `/tx/*` and read-endpoint tables, the `x-tensor-api-key` auth, the `TxResponseRest` shape, and the deserialize-sign-send flow.
- `resources/sdks.md` - the SDK options (`@tensor-foundation/marketplace`, legacy `@tensor-oss/tensorswap-sdk` and `@tensor-oss/tcomp-sdk`), the program id, and the cNFT Merkle-fields note.
- `examples/get-floor-and-buy.ts` - resolve collId, read `active_listings` for the floor, `GET /tx/buy`, deserialize + sign + send + confirm. Runnable with `@solana/web3.js`.
- `examples/list-and-bid.ts` - `GET /tx/list` then `GET /tx/collection_bid`, with the shared deserialize-sign-send helper and `bidState` capture.
- Tensor Developer Hub: https://dev.tensor.trade
- Tensor AI index (llms.txt): https://dev.tensor.trade/llms.txt
- REST base URL: https://api.mainnet.tensordev.io/api/v1
- Unified marketplace program: `TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp`
