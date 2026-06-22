/**
 * transfer-and-burn-cnft.ts
 *
 * Bubblegum v2 transfer and burn. Both operations need the asset's current
 * Merkle proof, fetched from a DAS-enabled RPC with getAssetWithProof.
 *
 * The proof is fetched IMMEDIATELY before each write and never reused: any
 * change to the tree (your write or anyone else's) advances the root and
 * invalidates an outstanding proof. The burn below therefore fetches its own
 * fresh proof even though a transfer just ran on the same tree.
 *
 * A DAS-enabled RPC (Helius / QuickNode / Triton) is MANDATORY. truncateCanopy
 * trims on-chain-cached proof nodes so the transaction fits under the size
 * limit (effective only when the tree has a canopy).
 *
 * Run:
 *   npm i @metaplex-foundation/mpl-bubblegum@5.0.2 \
 *         @metaplex-foundation/digital-asset-standard-api@2.0.0 \
 *         @metaplex-foundation/umi \
 *         @metaplex-foundation/umi-bundle-defaults
 *
 *   RPC_URL=https://<your-das-rpc> \
 *   SIGNER_SECRET_KEY=[12,34,...]  \    # owner of the cNFTs (JSON array)
 *   TRANSFER_ASSET_ID=<assetId> \
 *   RECIPIENT=<pubkey> \
 *   BURN_ASSET_ID=<assetId> \
 *     npx tsx transfer-and-burn-cnft.ts
 */

import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplBubblegum,
  getAssetWithProof,
  transferV2,
  burnV2,
} from "@metaplex-foundation/mpl-bubblegum";
import {
  keypairIdentity,
  publicKey,
  type PublicKey,
} from "@metaplex-foundation/umi";

const RPC_URL = process.env.RPC_URL;

function setupUmi() {
  if (!RPC_URL) {
    throw new Error(
      "Set RPC_URL to a DAS-enabled endpoint (Helius / QuickNode / Triton)."
    );
  }
  const umi = createUmi(RPC_URL).use(mplBubblegum());

  const secret = process.env.SIGNER_SECRET_KEY;
  if (!secret) {
    throw new Error(
      "Set SIGNER_SECRET_KEY (JSON array) to the secret key of the cNFT owner."
    );
  }
  const bytes = Uint8Array.from(JSON.parse(secret) as number[]);
  const keypair = umi.eddsa.createKeypairFromSecretKey(bytes);
  umi.use(keypairIdentity(keypair));
  return umi;
}

/**
 * Transfer one cNFT. Fetch a FRESH proof, then transferV2.
 *
 * For a v2 collection, also pass coreCollection.
 */
async function transferCnft(
  umi: ReturnType<typeof setupUmi>,
  assetId: PublicKey,
  recipient: PublicKey
) {
  console.log(`Transferring ${assetId} -> ${recipient}`);

  // Fetch the proof immediately before the write. Never cache or reuse it.
  const awp = await getAssetWithProof(umi, assetId, { truncateCanopy: true });

  await transferV2(umi, {
    ...awp,
    authority: umi.identity, // signer that owns or is delegated the leaf
    newLeafOwner: recipient,
    // coreCollection,
  }).sendAndConfirm(umi);

  console.log("  transfer confirmed");
}

/**
 * Burn one cNFT. Fetch a FRESH proof (the transfer above already moved the
 * root), then burnV2.
 *
 * For a v2 collection, also pass coreCollection.
 */
async function burnCnft(
  umi: ReturnType<typeof setupUmi>,
  assetId: PublicKey
) {
  console.log(`Burning ${assetId}`);

  // New proof, because the prior transfer advanced the tree root.
  const awp = await getAssetWithProof(umi, assetId, { truncateCanopy: true });

  await burnV2(umi, {
    ...awp,
    leafOwner: umi.identity.publicKey,
    // coreCollection,
  }).sendAndConfirm(umi);

  console.log("  burn confirmed");
}

async function main() {
  const umi = setupUmi();

  const transferId = process.env.TRANSFER_ASSET_ID;
  const recipient = process.env.RECIPIENT;
  const burnId = process.env.BURN_ASSET_ID;

  if (transferId && recipient) {
    await transferCnft(umi, publicKey(transferId), publicKey(recipient));
  } else {
    console.log("Skipping transfer (set TRANSFER_ASSET_ID and RECIPIENT).");
  }

  if (burnId) {
    await burnCnft(umi, publicKey(burnId));
  } else {
    console.log("Skipping burn (set BURN_ASSET_ID).");
  }

  console.log("\nDone. Reads will reflect these changes after DAS re-indexes.");
}

main().catch((e) => {
  console.error("transfer-and-burn-cnft failed:", e);
  process.exit(1);
});

export { setupUmi, transferCnft, burnCnft };
