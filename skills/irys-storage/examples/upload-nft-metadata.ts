/**
 * upload-nft-metadata.ts
 *
 * Upload an NFT's artwork and its Token Metadata JSON to Arweave via Irys,
 * paying with SOL. Produces a mint-ready metadata `uri` for Metaplex.
 *
 * Flow (run the size -> price -> fund -> upload cycle twice):
 *   1. upload the image, tagged with its image MIME type, capture imageUrl
 *   2. build Token Metadata JSON that references imageUrl
 *   3. upload the JSON, tagged Content-Type: application/json (so wallets and
 *      marketplaces render it), and return its gateway URL as the `uri`.
 *
 * Run:
 *   npm i @irys/upload @irys/upload-solana
 *
 *   SOLANA_PRIVATE_KEY=<base58> \
 *     npx tsx upload-nft-metadata.ts ./art.png "My NFT" MNFT "A permanent NFT."
 *   # or SOLANA_KEYPAIR_PATH=~/.config/solana/id.json
 *   # Devnet test: prefix IRYS_NETWORK=devnet (data deleted after ~60 days)
 */

import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const DEVNET_RPC = "https://api.devnet.solana.com";

function loadWallet(): string | number[] {
  const base58 = process.env.SOLANA_PRIVATE_KEY;
  if (base58) return base58;
  const keypairPath = process.env.SOLANA_KEYPAIR_PATH;
  if (keypairPath) {
    return JSON.parse(readFileSync(keypairPath, "utf8")) as number[];
  }
  throw new Error(
    "Set SOLANA_PRIVATE_KEY (base58) or SOLANA_KEYPAIR_PATH (keypair JSON file)."
  );
}

async function makeUploader() {
  const wallet = loadWallet();
  if (process.env.IRYS_NETWORK === "devnet") {
    return Uploader(Solana).withWallet(wallet).withRpc(DEVNET_RPC).devnet();
  }
  return Uploader(Solana).withWallet(wallet);
}

/** Map a file extension to an image MIME type for the Content-Type tag. */
function imageMime(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "application/octet-stream";
  }
}

/** Quote, fund only if over the free tier, then return the work to do. */
async function fundIfNeeded(irys: any, bytes: number): Promise<void> {
  const price = await irys.getPrice(bytes);
  if (BigInt(price.toString()) > 0n) {
    console.log(
      `  cost ${price} atomic (${irys.utils.fromAtomic(price)} SOL), funding...`
    );
    await irys.fund(price); // on-chain SOL tx; balance can lag a few seconds
  } else {
    console.log("  under the free tier (price 0), no funding needed");
  }
}

async function main() {
  const [imagePath, name, symbol, description] = process.argv.slice(2);
  if (!imagePath || !name) {
    console.error(
      'Usage: npx tsx upload-nft-metadata.ts <image> <name> [symbol] [description]'
    );
    process.exit(1);
  }

  const irys = await makeUploader();
  console.log("Funding wallet:", irys.address);
  const gateway = "https://gateway.irys.xyz";

  // 1) Upload the image (typically over the free tier, so it is funded).
  const contentType = imageMime(imagePath);
  console.log(`\n[1/2] image ${imagePath} (${contentType})`);
  await fundIfNeeded(irys, statSync(imagePath).size);
  const imgReceipt = await irys.uploadFile(imagePath);
  const imageUrl = `${gateway}/${imgReceipt.id}`;
  console.log("  image URL:", imageUrl);

  // 2) Build Metaplex Token Metadata JSON referencing the uploaded image.
  const metadata = {
    name,
    symbol: symbol ?? "",
    description: description ?? "",
    image: imageUrl,
    attributes: [] as Array<{ trait_type: string; value: string }>,
    properties: {
      files: [{ uri: imageUrl, type: contentType }],
      category: "image",
    },
  };
  const json = JSON.stringify(metadata);

  // 3) Upload the JSON tagged as application/json so wallets render it.
  console.log("\n[2/2] metadata JSON");
  await fundIfNeeded(irys, Buffer.byteLength(json));
  const jsonReceipt = await irys.upload(json, {
    tags: [{ name: "Content-Type", value: "application/json" }],
  });
  const metadataUri = `${gateway}/${jsonReceipt.id}`;

  console.log("\nDone. Pass this as the mint's metadata uri:");
  console.log("  uri:  ", metadataUri);
  console.log("  image:", imageUrl);
  if (process.env.IRYS_NETWORK === "devnet") {
    console.log(
      "\n(devnet: ephemeral, deleted after ~60 days. Re-upload on mainnet before minting.)"
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
