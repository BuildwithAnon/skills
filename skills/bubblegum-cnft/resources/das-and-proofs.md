# DAS Reads and Merkle Proofs

Compressed NFTs do not live in token accounts. Only the Merkle tree's root hash is stored on chain; each leaf's metadata is emitted into the transaction log by the SPL Noop program and indexed off chain. That means two things are true for every cNFT operation that touches data:

1. **Every read goes through the Digital Asset Standard (DAS) API.** Standard RPC methods like `getTokenAccountsByOwner` or `getProgramAccounts` cannot see a cNFT.
2. **Every write (transfer, burn) needs a Merkle proof** that the leaf belongs to the current root. The proof is served by DAS too.

A plain public RPC (`api.mainnet-beta.solana.com`, `api.devnet.solana.com`) does **not** serve DAS. You must use a DAS-enabled provider: Helius, QuickNode, or Triton. This is mandatory, not an optimization.

## Setting up Umi for DAS

```ts
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import { mplBubblegum } from "@metaplex-foundation/mpl-bubblegum";
import { dasApi } from "@metaplex-foundation/digital-asset-standard-api";

const umi = createUmi(process.env.RPC_URL!) // DAS-enabled endpoint
  .use(mplBubblegum());                      // includes dasApi() automatically

// dasApi() is already registered by mplBubblegum(). Add it explicitly only if
// you want it obvious or are not using the Bubblegum plugin:
// umi.use(dasApi());
```

The DAS methods then live on `umi.rpc` at runtime. The `dasApi()` plugin registers them but does not augment the `RpcInterface` type, so in strict TypeScript you may need to cast `umi.rpc` to `DasApiInterface` (`import type { DasApiInterface } from "@metaplex-foundation/digital-asset-standard-api"`) at the call site. Running the examples with `npx tsx` (which transpiles without type-checking) needs no cast.

## DAS read methods

```ts
// List all assets (cNFT + regular NFT) owned by an address.
// Paginate with `page` and `limit`; limit max is 1000.
const owned = await umi.rpc.getAssetsByOwner({ owner, limit: 1000 });

// Fetch one asset's full metadata by asset id.
const asset = await umi.rpc.getAsset(assetId);

// Fetch the raw Merkle proof for an asset (getAssetWithProof wraps this).
const proof = await umi.rpc.getAssetProof(assetId);

// List every asset in a collection (or other group key).
const inCollection = await umi.rpc.getAssetsByGroup({
  groupKey: "collection",
  groupValue: collectionAddress,
  limit: 1000,
});
```

Distinguish a cNFT from a regular NFT in any of these results with the compression flag:

```ts
const cnfts = owned.items.filter((a) => a.compression?.compressed === true);
```

## The getAssetWithProof flow for writes

`transferV2` and `burnV2` (and their v1 counterparts) need the leaf, the tree, the leaf index, the root, and the proof path. The Umi helper bundles all of it from DAS so you can spread it straight into the instruction:

```ts
import { getAssetWithProof, transferV2 } from "@metaplex-foundation/mpl-bubblegum";

// Fetch IMMEDIATELY before the write. Do not cache or reuse this.
const awp = await getAssetWithProof(umi, assetId, { truncateCanopy: true });

await transferV2(umi, {
  ...awp,                  // leaf, tree, index, root, proof, etc.
  authority: currentOwner, // signer that owns or is delegated the leaf
  newLeafOwner: recipient,
}).sendAndConfirm(umi);
```

### truncateCanopy

`getAssetProof` returns the full proof path. If the tree has a canopy (top proof levels cached on chain), those nodes do not need to ride along in the transaction. `truncateCanopy: true` tells the helper to drop the cached levels from the returned proof, shrinking the transaction so it fits under the size limit. Use it whenever the tree has a canopy. If the tree has no canopy, truncation does nothing, and a deep tree may simply be untransferable in one transaction: that is a creation-time decision that cannot be fixed afterward.

## Proof staleness, the rule that breaks people

A proof is valid only against the root it was fetched against. **Any** change to the tree advances the root and invalidates outstanding proofs:

- your own mint, transfer, or burn,
- a transfer or burn by anyone else on the same tree,
- a concurrent mint into the same tree.

The on-chain change buffer (`maxBufferSize`) absorbs a limited number of recent changes, but you should not rely on it. The safe rule is absolute:

> Fetch the proof with `getAssetWithProof` in the same code path, immediately before each write. Never reuse a proof across two writes, even for different assets on the same tree.

If a transfer or burn fails with an invalid-root or leaf-mismatch style error, the proof was stale. Re-fetch and retry.

## Indexer lag

DAS is an indexer. After a mint, transfer, or burn confirms on chain, the DAS view can lag by a short interval before it reflects the change. Do not assert a just-minted asset id from `getAssetsByOwner` instantly; poll briefly or read back after the indexer catches up. For proofs this lag is what makes a slightly-old proof dangerous, which is the reason for the fetch-immediately-before-write rule above.

## Why not the token program

`getTokenAccountsByOwner`, `getProgramAccounts` on the Token program, and balance RPCs return nothing for cNFTs because no token account exists. The cNFT is a hash in a Merkle tree. The only correct read path is DAS.
