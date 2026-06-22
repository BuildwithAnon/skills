# Bubblegum Program IDs and Tree Sizing

## Program IDs

These are the same on mainnet-beta and devnet. With Umi, `mplBubblegum()` wires all three automatically; you rarely reference them directly, but they are listed for verification, raw-instruction work, and explorer lookups.

| Program | Address |
|---------|---------|
| Bubblegum | `BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY` |
| SPL Account Compression | `cmtDvXumGCrqC1Age74AVPhSRVXJMd8PJS91L8KbNCK` |
| SPL Noop (log wrapper) | `noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV` |

The Bubblegum program owns the cNFT logic. SPL Account Compression owns the concurrent Merkle tree account (the root and the change buffer). SPL Noop emits the leaf metadata into the transaction log so indexers can reconstruct it; it does nothing on chain by design.

## Package versions (JS/TS, 2026)

```bash
npm install \
  @metaplex-foundation/mpl-bubblegum@5.0.2 \
  @metaplex-foundation/digital-asset-standard-api@2.0.0 \
  @metaplex-foundation/umi \
  @metaplex-foundation/umi-bundle-defaults
```

- `@metaplex-foundation/mpl-bubblegum@5.0.2`: Bubblegum v2 + v1 instructions and the `getAssetWithProof` helper.
- `@metaplex-foundation/digital-asset-standard-api@2.0.0`: provides `dasApi()`. `mplBubblegum()` already includes it; add `.use(dasApi())` only if you want it explicit.
- `@metaplex-foundation/umi` + `@metaplex-foundation/umi-bundle-defaults`: the Umi framework and `createUmi`.

The Rust crate version is not pinned here on purpose: published sources disagree (docs.rs has shown 2.1.1, another source said 3.0.0), so check `crates.io` / `docs.rs` for `mpl-bubblegum` directly rather than trusting a number copied from here. The JS facts above are firm.

## Tree sizing

Capacity is `2 ** maxDepth`. The geometry (`maxDepth`, `maxBufferSize`, `canopyDepth`) is set at `createTreeV2`/`createTree` time and is **immutable**. There is no resize, so size for peak supply.

| maxDepth | Capacity (2**depth) | Typical maxBufferSize | Approx tree rent | Use for |
|----------|---------------------|-----------------------|------------------|---------|
| 3 | 8 | 8 | negligible | tests |
| 14 | 16,384 | 64 | ~0.34 SOL | small drop |
| 17 | 131,072 | 64 | mid | mid collection |
| 20 | 1,048,576 | 256 | ~7.7 to 8.5 SOL | ~1M collection |
| 24 | 16,777,216 | 512 to 1024 | high | large supply |
| 30 | 1,073,741,824 | 1024 to 2048 | very high | massive / points |

Rent figures are approximate and depend on `canopyDepth`; a larger canopy raises rent but shrinks every transfer/burn transaction. Verify the live rent for a specific config before allocating a large tree.

### maxBufferSize

`maxBufferSize` is the depth of the on-chain change buffer: how many concurrent leaf changes the tree can absorb before an in-flight proof goes stale. Higher buffer = more parallel mints/transfers tolerated, at higher rent. Only certain `(maxDepth, maxBufferSize)` pairs are accepted by the SPL Account Compression program (the `ALL_DEPTH_SIZE_PAIRS` set, exported by the `@solana/spl-account-compression` package, not by mpl-bubblegum); an invalid pair is rejected at creation.

Commonly valid pairs (not exhaustive; use the table below or consult `ALL_DEPTH_SIZE_PAIRS` for the full list):

| maxDepth | valid maxBufferSize values (examples) |
|----------|----------------------------------------|
| 3 | 8 |
| 5 | 8 |
| 14 | 64, 256, 1024, 2048 |
| 15 | 64 |
| 20 | 64, 256, 1024, 2048 |
| 24 | 64, 256, 512, 1024, 2048 |
| 30 | 512, 1024, 2048 |

### canopyDepth

`canopyDepth` caches the top `canopyDepth` levels of the proof on chain. A transfer/burn proof normally needs `maxDepth` nodes; with a canopy of depth C, only `maxDepth - C` nodes must be supplied in the transaction. This is what keeps deep-tree writes under the transaction size limit. Trade-off: higher canopy = more rent at creation. For trees of depth 20+, a canopy of 10 to 14 is common. Pair it with `getAssetWithProof(umi, assetId, { truncateCanopy: true })` so the helper trims the cached nodes from the proof it returns.

### Sizing rule of thumb

1. Decide peak supply N. Pick the smallest `maxDepth` with `2 ** maxDepth >= N`.
2. Pick `maxBufferSize` from the valid pairs for that depth based on expected mint concurrency.
3. For depth >= 18 or so, add a `canopyDepth` (often 10 to 14) so transfers/burns fit in one transaction.
4. All three are permanent. When in doubt, size up: a too-small tree cannot be grown.
