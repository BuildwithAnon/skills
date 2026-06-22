/**
 * create-tree-and-mint.ts
 *
 * Bubblegum v2 end to end: allocate a concurrent Merkle tree with createTreeV2,
 * mint a compressed NFT into it with mintV2, then read the owner's cNFTs back
 * through the DAS API.
 *
 * A DAS-enabled RPC (Helius / QuickNode / Triton) is MANDATORY. A plain
 * api.mainnet-beta / api.devnet endpoint does not serve DAS and the read step
 * will fail.
 *
 * Run:
 *   npm i @metaplex-foundation/mpl-bubblegum@5.0.2 \
 *         @metaplex-foundation/digital-asset-standard-api@2.0.0 \
 *         @metaplex-foundation/umi \
 *         @metaplex-foundation/umi-bundle-defaults
 *
 *   RPC_URL=https://<your-das-rpc> \
 *   SIGNER_SECRET_KEY=[12,34,...]  \   # JSON array of the payer secret key bytes
 *     npx tsx create-tree-and-mint.ts
 *
 * If SIGNER_SECRET_KEY is omitted, a throwaway signer is generated; on a live
 * cluster that wallet must be funded before createTreeV2 will land.
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplBubblegum,
  createTreeV2,
  mintV2,
} from "@metaplex-foundation/mpl-bubblegum";
import {
  generateSigner,
  keypairIdentity,
  none,
  type PublicKey,
} from "@metaplex-foundation/umi";

const RPC_URL = process.env.RPC_URL;

/** Build Umi on a DAS-enabled RPC with the Bubblegum plugin (DAS included). */
function setupUmi() {
  if (!RPC_URL) {
    throw new Error(
      "Set RPC_URL to a DAS-enabled endpoint (Helius / QuickNode / Triton)."
    );
  }
  const umi = createUmi(RPC_URL).use(mplBubblegum());

  const secret = process.env.SIGNER_SECRET_KEY;
  if (secret) {
    const bytes = Uint8Array.from(JSON.parse(secret) as number[]);
    const keypair = umi.eddsa.createKeypairFromSecretKey(bytes);
    umi.use(keypairIdentity(keypair));
  } else {
    // Throwaway signer. On a live cluster this wallet must be funded first.
    umi.use(keypairIdentity(generateSigner(umi)));
  }
  return umi;
}

/**
 * Step 1: allocate the tree.
 *
 * Capacity is 2 ** maxDepth. Only valid (maxDepth, maxBufferSize) pairs are
 * accepted (ALL_DEPTH_SIZE_PAIRS). All geometry is immutable, so size for peak
 * supply. depth 14 = 16,384 cNFTs, ~0.34 SOL rent.
 */
async function createTree(umi: ReturnType<typeof setupUmi>): Promise<PublicKey> {
  const merkleTree = generateSigner(umi);

  console.log("Creating Merkle tree (v2)...");
  console.log(`  capacity: ${Math.pow(2, 14).toLocaleString()} cNFTs`);

  // createTreeV2 is async (it sizes the tree account via RPC); await the builder.
  const builder = await createTreeV2(umi, {
    merkleTree,
    maxDepth: 14,
    maxBufferSize: 64,
    // canopyDepth: 10, // add for deeper trees to keep transfers/burns small
  });
  await builder.sendAndConfirm(umi);

  console.log("  tree:", merkleTree.publicKey);
  return merkleTree.publicKey;
}

/**
 * Step 2: mint one cNFT to leafOwner.
 *
 * For a v2 collection, also pass coreCollection (an MPL-Core collection with
 * the BubblegumV2 plugin) and collectionAuthority; no separate verify step.
 */
async function mintOne(
  umi: ReturnType<typeof setupUmi>,
  merkleTree: PublicKey,
  leafOwner: PublicKey
) {
  console.log("Minting cNFT...");

  await mintV2(umi, {
    leafOwner,
    merkleTree,
    // coreCollection,
    // collectionAuthority,
    metadata: {
      name: "My cNFT #1",
      uri: "https://example.com/metadata.json",
      sellerFeeBasisPoints: 500, // 5% royalty
      collection: none(),
      creators: [
        { address: umi.identity.publicKey, verified: true, share: 100 },
      ],
    },
  }).sendAndConfirm(umi);

  console.log("  minted to:", leafOwner);
}

/**
 * Step 3: read the owner's cNFTs back via DAS.
 *
 * DAS is an indexer and lags the chain slightly, so the fresh mint may not show
 * up on the first call. Poll a few times before giving up.
 */
async function listCnfts(
  umi: ReturnType<typeof setupUmi>,
  owner: PublicKey
) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await umi.rpc.getAssetsByOwner({ owner, limit: 1000 });
    const cnfts = res.items.filter((a) => a.compression?.compressed === true);
    if (cnfts.length > 0 || attempt === 5) {
      console.log(`Owner holds ${cnfts.length} cNFT(s):`);
      for (const a of cnfts) {
        console.log(`  - ${a.content?.metadata?.name ?? "(no name)"} (${a.id})`);
      }
      return cnfts;
    }
    console.log(`  indexer lag, retrying (${attempt}/5)...`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return [];
}

async function main() {
  const umi = setupUmi();
  const owner = umi.identity.publicKey;
  console.log("Payer / owner:", owner);

  const tree = await createTree(umi);
  await mintOne(umi, tree, owner);
  await listCnfts(umi, owner);

  console.log("\nSave this tree address; its geometry is immutable:");
  console.log("  TREE:", tree);
}

main().catch((e) => {
  console.error("create-tree-and-mint failed:", e);
  process.exit(1);
});

export { setupUmi, createTree, mintOne, listCnfts };
