# Tensor on-chain SDKs

Use the SDKs only when you explicitly need client-side instruction building (batch into a custom transaction, no REST rate limit, advanced control). For ordinary agent trading, prefer the REST API in `rest-endpoints.md`: it builds the transaction and resolves cNFT Merkle proofs for you.

## Program id

Unified marketplace program (the address `@tensor-foundation/marketplace` exports as `TENSOR_MARKETPLACE_PROGRAM_ADDRESS`):

```
TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp
```

## Package options

| Package | Scope | Notes |
|---------|-------|-------|
| `@tensor-foundation/marketplace` | Newest, unified (regular + compressed) | Preferred SDK path. Targets the unified program above. |
| `@tensor-oss/tensorswap-sdk` | Legacy, regular NFTs | Older TensorSwap surface. |
| `@tensor-oss/tcomp-sdk` | Legacy, compressed NFTs (tcomp) | You must supply Merkle fields yourself (see below). |

### Version note

The org has been renamed twice (`tensor-hq` -> `tensor-oss` -> `tensor-foundation`), so versions drift across that history. The three package names above are published and resolve on npm; pin whichever current version `npm install` gives you rather than hardcoding a version string here.

## cNFT Merkle fields (SDK only)

This is the central difference from REST. With `@tensor-oss/tcomp-sdk` (and any client-side compressed-NFT path), the REST server-side proof resolution is not available, so **you** must fetch and pass every Merkle field for the compressed NFT yourself. Pull them from a DAS provider (`getAsset` + `getAssetProof`):

- `merkleTree` (the tree account address)
- `root`
- `canopyDepth`
- `index` (the leaf index)
- `proof` (the proof path)
- `dataHash`
- `creatorsHash`

Fetch these immediately before building the transaction. A stale root or proof (the tree changed between fetch and submit) will fail the trade. If this is fragile in your setup, switch to the REST API, which refetches the proof server-side at build time.

## When to choose SDK vs REST

- **REST** (default): straightforward buy/list/sell/bid, server-built tx, server-side cNFT proofs, gated key, ALPHA, unknown rate limit.
- **SDK**: client-side instruction building, batching into a custom transaction, no REST key needed, no REST rate limit; in exchange you own the cNFT Merkle-proof fetching and version pinning.

## References

- Tensor Developer Hub: https://dev.tensor.trade
- AI index: https://dev.tensor.trade/llms.txt
- npm packages: `@tensor-foundation/marketplace`, `@tensor-oss/tensorswap-sdk`, `@tensor-oss/tcomp-sdk`
