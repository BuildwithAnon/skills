---
name: bubblegum-cnft
description: Create and manage Metaplex Bubblegum compressed NFTs on Solana. Allocate a Merkle tree, mint, transfer, burn, and read cNFTs. Use when minting NFTs cheaply at scale, building large collections, drops, loyalty points, or game assets, or when you see compressed NFT, cNFT, Bubblegum, Merkle tree, concurrent merkle tree, leaf/proof, getAssetWithProof, DAS, or getAssetsByOwner. Covers Bubblegum v2 (createTreeV2, mintV2, transferV2, burnV2 with MPL-Core collections) and the v1 functions, the mandatory DAS-enabled RPC for all reads and write proofs, tree sizing (maxDepth/maxBufferSize/canopyDepth), and proof staleness.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Bubblegum Compressed NFTs

Metaplex Bubblegum stores NFTs as leaves in an on-chain concurrent Merkle tree instead of one account per NFT, so a collection of thousands or millions costs a fraction of regular NFTs. Only the tree's root hash lives on chain; the leaf data lives in the transaction log and is reconstructed by an indexer. That single design choice drives every rule in this skill: you size a tree up front and can never resize it, and you cannot read or move a cNFT without a Merkle proof served by a DAS-enabled RPC.

## Overview

A compressed NFT (cNFT) is not an SPL token account. It is a hashed leaf in a concurrent Merkle tree owned by the SPL Account Compression program. Minting appends a leaf and updates the on-chain root; the human-readable metadata is emitted via the SPL Noop program into the transaction log, where indexers pick it up. Because of this:

- **Reads go through DAS, not the token program.** `getTokenAccountsByOwner` will never see a cNFT. You list, fetch, and verify cNFTs through the Digital Asset Standard (DAS) API, which a standard public RPC does not serve. A DAS-enabled RPC (Helius, QuickNode, Triton) is mandatory.
- **Writes need a fresh proof.** Transfer and burn must prove the leaf belongs to the current root. The proof is fetched from DAS and goes stale the instant the tree changes, so it must be fetched immediately before each write.
- **Tree geometry is permanent.** `maxDepth`, `maxBufferSize`, and `canopyDepth` are set at creation and are immutable. Size for peak supply, because there is no resize.

This skill targets **Bubblegum v2**, current in 2026 (`createTreeV2`, `mintV2`, `transferV2`, `burnV2`). v2 uses MPL-Core collections, drops the separate collection-verify step, and adds freeze, soulbound, and enforced royalties. The original v1 functions (`createTree`, `mintV1`, `mintToCollectionV1`, `transfer`, `burn`) still exist. **v1 and v2 trees are not interchangeable**: a tree created with `createTreeV2` accepts only v2 mints and v2 transfers/burns. Decompression (turning a cNFT back into a regular Token Metadata NFT) is **v1 only**; do not promise decompress on a v2 tree.

Use this skill when a user wants to mint NFTs cheaply at scale, build a large drop or collection, issue game items or loyalty assets as NFTs, or move/burn/read cNFTs they already hold.

## Instructions

Work in order. Steps 1 and 2 create supply; steps 3 and 4 move it; step 5 reads it. Stop at the step that answers the user's request.

### Step 0: Confirm a DAS-enabled RPC

Before anything else, confirm the RPC URL serves DAS. A plain `api.mainnet-beta.solana.com` or `api.devnet.solana.com` endpoint does **not** serve DAS and will make every read and every transfer/burn proof fail. Set `RPC_URL` to a Helius, QuickNode, or Triton endpoint. With Umi, point `createUmi(RPC_URL)` at that endpoint; the program ids (Bubblegum, Account Compression, Noop) are wired automatically by `mplBubblegum()`, and `dasApi()` is included by that plugin (you may also add it explicitly with `.use(dasApi())`).

**Success criterion:** `RPC_URL` is a DAS-capable endpoint, and `createUmi(RPC_URL).use(mplBubblegum())` is set up. See `resources/das-and-proofs.md`.

### Step 1: Create the Merkle tree

Pick `maxDepth` from peak supply: capacity is `2 ** maxDepth`. Only specific `(maxDepth, maxBufferSize)` pairs are valid; a wrong pair is rejected. `maxBufferSize` is the number of concurrent writes the tree tolerates before a proof goes stale; raise it for high-throughput minting. `canopyDepth` caches the top proof nodes on chain, which shrinks transfer/burn transactions at the cost of more rent. All three are immutable. See the sizing table and valid pairs in `resources/addresses.md`.

`createTreeV2` is async (it sizes the tree account via an RPC call), so `await` it to get the builder, then send:

```ts
const merkleTree = generateSigner(umi);
const builder = await createTreeV2(umi, {
  merkleTree,
  maxDepth: 14,        // capacity 2**14 = 16,384 cNFTs
  maxBufferSize: 64,
  // canopyDepth: 10,  // optional; cache proof nodes on chain for smaller writes
});
await builder.sendAndConfirm(umi);
const treeAddress = merkleTree.publicKey;
```

**Success criterion:** the create transaction confirms and you have saved `merkleTree.publicKey`. Capacity and the chosen `(maxDepth, maxBufferSize, canopyDepth)` are recorded, since they cannot change later.

### Step 2: Mint a cNFT

Mint a leaf to `leafOwner` against the tree. For a v2 collection, pass `coreCollection` (an MPL-Core collection that has the `BubblegumV2` plugin) and the `collectionAuthority`; no separate verify step is needed. The mint authority is the tree creator (or a delegate) by default.

```ts
await mintV2(umi, {
  leafOwner,
  merkleTree: treeAddress,
  // coreCollection,            // optional MPL-Core collection with BubblegumV2 plugin
  // collectionAuthority,       // required when coreCollection is set
  metadata: {
    name: "My cNFT",
    uri: "https://example.com/metadata.json",
    sellerFeeBasisPoints: 500,  // 5% royalty
    collection: none(),         // v2: some(coreCollection) (just the pubkey, always verified)
    creators: [
      { address: umi.identity.publicKey, verified: true, share: 100 },
    ],
  },
}).sendAndConfirm(umi);
```

**Success criterion:** the mint confirms. The new asset id is derivable from the tree and leaf index; in practice you read it back via DAS (Step 5) once the indexer has caught up.

### Step 3: Transfer a cNFT (requires a fresh proof)

You need the asset's current Merkle proof from DAS. Use the Umi helper, then spread its result into `transferV2`. Pass `truncateCanopy: true` when the tree has a canopy so the helper trims the on-chain-cached nodes and the proof fits in one transaction.

```ts
const awp = await getAssetWithProof(umi, assetId, { truncateCanopy: true });
await transferV2(umi, {
  ...awp,
  authority: currentOwner,      // the signer that owns or is delegated the leaf
  newLeafOwner: recipient,
  // coreCollection,            // pass if the cNFT belongs to a v2 collection
}).sendAndConfirm(umi);
```

**Success criterion:** transfer confirms. Fetch the proof immediately before this call; any other write to the same tree in between invalidates it (see Common Errors). After it confirms, any cached proof for this asset is stale.

### Step 4: Burn a cNFT (requires a fresh proof)

Same proof flow, then `burnV2`.

```ts
const awp = await getAssetWithProof(umi, assetId, { truncateCanopy: true });
await burnV2(umi, {
  ...awp,
  leafOwner: currentOwner,
  // coreCollection,            // pass if the cNFT belongs to a v2 collection
}).sendAndConfirm(umi);
```

**Success criterion:** burn confirms; the leaf is removed and the asset id no longer resolves to an owned asset in DAS.

### Step 5: Read cNFTs via DAS

All cNFT reads go through DAS on the Umi `rpc` namespace. List by owner, fetch one, fetch a raw proof, or list by collection group.

```ts
// All assets (cNFT + regular) for an owner. Paginate with page/limit (max 1000).
const owned = await umi.rpc.getAssetsByOwner({ owner, limit: 1000 });

// A single asset's full metadata.
const asset = await umi.rpc.getAsset(assetId);

// The raw Merkle proof (getAssetWithProof wraps this for writes).
const proof = await umi.rpc.getAssetProof(assetId);

// Every asset in a collection group.
const inCollection = await umi.rpc.getAssetsByGroup({
  groupKey: "collection",
  groupValue: collectionAddress,
  limit: 1000,
});
```

A cNFT has `asset.compression.compressed === true`. Regular NFTs returned by the same call have it `false`.

**Success criterion:** the DAS call returns the expected assets. If it errors with "method not found" or returns nothing for a known-good owner, the RPC is not DAS-enabled (Step 0).

## Examples

### Example 1: Stand up a tree and mint the first cNFT

User asks: "Set up compressed NFTs and mint one to my wallet."

1. Confirm `RPC_URL` is DAS-enabled (Step 0).
2. `createTreeV2` with `maxDepth: 14`, `maxBufferSize: 64` (16,384 capacity) and save `merkleTree.publicKey`.
3. `mintV2` with `leafOwner = umi.identity.publicKey` and the metadata.
4. After the indexer catches up, `getAssetsByOwner` to read back the new cNFT and its asset id.

`examples/create-tree-and-mint.ts` runs exactly this flow end to end and prints the tree address and the owner's cNFT list.

### Example 2: Transfer then burn a cNFT held by the signer

User asks: "Send cNFT `<assetId>` to `<recipient>`, then burn another one."

1. `getAssetWithProof(umi, assetId, { truncateCanopy: true })` to fetch a **fresh** proof.
2. `transferV2({ ...awp, authority: currentOwner, newLeafOwner: recipient })` and confirm.
3. For the burn, fetch a **new** proof (the prior one is now stale even for a different asset on the same tree) and call `burnV2({ ...awp, leafOwner: currentOwner })`.

`examples/transfer-and-burn-cnft.ts` shows both, each with its own immediately-preceding `getAssetWithProof`.

### Example 3: List a wallet's compressed NFTs

User asks: "What cNFTs does `<owner>` hold?"

1. Build Umi on a DAS RPC: `createUmi(RPC_URL).use(mplBubblegum())` (DAS is included; `.use(dasApi())` is optional).
2. `umi.rpc.getAssetsByOwner({ owner, limit: 1000 })`.
3. Filter `items` to `a.compression?.compressed === true` for cNFTs only.

Note that `getTokenAccountsByOwner` returns nothing for cNFTs; this is the only correct path.

## Guidelines

- **DO** use a DAS-enabled RPC for every read and for every transfer/burn proof. This is not optional.
- **DO** fetch the proof with `getAssetWithProof` immediately before each `transferV2`/`burnV2`, never reuse a proof across writes.
- **DO** size the tree for peak supply on day one. `maxDepth`, `maxBufferSize`, and `canopyDepth` are immutable.
- **DO** add `canopyDepth` to deep trees and pass `truncateCanopy: true` to the proof helper, so transfer/burn transactions stay under the size limit.
- **DO** match v2 to v2: a `createTreeV2` tree needs `mintV2`/`transferV2`/`burnV2`. v1 functions target v1 trees only.
- **DON'T** call `getTokenAccountsByOwner` for cNFTs; they are not token accounts.
- **DON'T** promise decompression on a v2 tree. Decompress is v1 only.
- **DON'T** mix a v1 and v2 tree, or pass a v1 proof to a v2 instruction.
- **DON'T** hardcode the asset id from a mint; read it back via DAS after the indexer catches up.
- **DON'T** assume a `(maxDepth, maxBufferSize)` pair is valid; only the `ALL_DEPTH_SIZE_PAIRS` combinations are accepted.

## Common Errors

### Error: DAS method not found / empty reads on a known wallet
**Cause:** The RPC is a plain Solana endpoint that does not serve the DAS API (`getAssetsByOwner`, `getAsset`, `getAssetProof`).
**Solution:** Point `RPC_URL` at a DAS-enabled provider (Helius, QuickNode, Triton). Without it, cNFT reads and write proofs cannot work.

### Error: transfer/burn fails with an invalid root / leaf mismatch
**Cause:** The Merkle proof went stale. Any write to the tree (a mint, transfer, or burn, including by someone else) advances the root and invalidates a previously fetched proof.
**Solution:** Fetch a fresh proof with `getAssetWithProof` in the same code path, immediately before the write. Do not cache it.

### Error: transaction too large on transfer/burn
**Cause:** A deep tree with a low or zero canopy produces a proof with too many nodes to fit in one transaction.
**Solution:** If the tree has a canopy, pass `getAssetWithProof(umi, assetId, { truncateCanopy: true })` so the on-chain-cached nodes are trimmed from the proof. If the tree has no canopy, this cannot be fixed after creation; size canopy in for future trees.

### Error: invalid depth/buffer size on createTree
**Cause:** The `(maxDepth, maxBufferSize)` pair is not one of the valid `ALL_DEPTH_SIZE_PAIRS`.
**Solution:** Use a known-good pair from the sizing table in `resources/addresses.md` (e.g. depth 14 / buffer 64, depth 20 / buffer 256).

### Error: v2 instruction rejects a v1 tree (or vice versa)
**Cause:** The function family does not match the tree family. v2 trees only accept v2 mints/transfers/burns.
**Solution:** Use the matching family. If you created with `createTreeV2`, use `mintV2`/`transferV2`/`burnV2` and pass v2 collection args.

### Error: decompress fails on a v2 tree
**Cause:** Decompression is implemented only for v1 trees.
**Solution:** Do not offer decompress for v2. If decompress is a requirement, create a v1 tree (`createTree`) and use `decompressV1`.

## References

- `resources/addresses.md`: Bubblegum, SPL Account Compression, and SPL Noop program ids, plus the tree sizing/capacity/cost table and valid depth/buffer pairs.
- `resources/das-and-proofs.md`: why a DAS RPC is mandatory, the `getAssetWithProof` flow, the DAS read methods, and proof staleness rules.
- `examples/create-tree-and-mint.ts`: `createTreeV2` then `mintV2`, then read back via `getAssetsByOwner`. Runnable with the mpl-bubblegum + Umi stack.
- `examples/transfer-and-burn-cnft.ts`: `transferV2` and `burnV2`, each with an immediately-preceding `getAssetWithProof({ truncateCanopy: true })`.
- Metaplex Bubblegum docs: https://developers.metaplex.com/bubblegum-v2
- mpl-bubblegum TypeDoc: https://mpl-bubblegum.typedoc.metaplex.com
- DAS API (digital-asset-standard-api): https://developers.metaplex.com/das-api
- SPL Account Compression: https://spl.solana.com/account-compression
