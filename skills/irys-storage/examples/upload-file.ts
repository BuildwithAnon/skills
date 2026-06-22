/**
 * upload-file.ts
 *
 * Upload a single file to Arweave permanent storage via Irys, paying with SOL.
 *
 * Flow: construct -> stat (size) -> getPrice -> fund (only if over the free
 *       tier) -> uploadFile -> build the permanent gateway URL.
 *
 * Run:
 *   npm i @irys/upload @irys/upload-solana
 *
 *   # Wallet key: a base58 private key string OR a path to a Solana keypair
 *   # JSON file (the byte array `solana-keygen` writes). Mainnet by default.
 *   SOLANA_PRIVATE_KEY=<base58>            npx tsx upload-file.ts ./logo.png
 *   # or
 *   SOLANA_KEYPAIR_PATH=~/.config/solana/id.json  npx tsx upload-file.ts ./logo.png
 *
 *   # Free, ephemeral devnet test (data deleted after ~60 days):
 *   IRYS_NETWORK=devnet SOLANA_PRIVATE_KEY=<base58> npx tsx upload-file.ts ./logo.png
 */

import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";
import { readFileSync, statSync } from "node:fs";

const DEVNET_RPC = "https://api.devnet.solana.com";

/**
 * Resolve the wallet input from the environment.
 * Returns either the base58 string or the parsed keypair byte array; both are
 * accepted by `withWallet`.
 */
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

/** Build a mainnet or devnet uploader. Devnet REQUIRES an RPC URL. */
async function makeUploader() {
  const wallet = loadWallet();

  if (process.env.IRYS_NETWORK === "devnet") {
    return Uploader(Solana).withWallet(wallet).withRpc(DEVNET_RPC).devnet();
  }
  // Mainnet: permanent storage. Omit withRpc/devnet.
  return Uploader(Solana).withWallet(wallet);
}

async function main() {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: npx tsx upload-file.ts <path-to-file>");
    process.exit(1);
  }

  const irys = await makeUploader();
  console.log("Funding wallet:", irys.address);

  // Step 3: size the payload and quote the cost (atomic units = lamports).
  const size = statSync(path).size;
  const price = await irys.getPrice(size); // returns a BigInt-like atomic value
  console.log(
    `File: ${path}  size: ${size} bytes  price: ${price} atomic (${irys.utils.fromAtomic(
      price
    )} SOL)`
  );

  // Step 4: fund ONLY if the payload is over the free tier (price > 0).
  // Small mainnet payloads (under ~100 KiB) are free, so price is 0 and we skip.
  if (BigInt(price.toString()) > 0n) {
    const before = await irys.getBalance();
    console.log(`Balance before: ${before} atomic. Funding ${price}...`);
    const fundReceipt = await irys.fund(price);
    console.log("Funded. Tx:", fundReceipt?.id ?? fundReceipt);
    // NOTE: fund() is an on-chain SOL tx; the credited balance can lag a few
    // seconds. For batch uploads, fund a little extra or keep a standing balance.
  } else {
    console.log("Under the free tier (price 0). Skipping funding.");
  }

  // Step 5: upload and build the permanent URL.
  const receipt = await irys.uploadFile(path);
  const url = `https://gateway.irys.xyz/${receipt.id}`;
  console.log("\nUploaded.");
  console.log("Id:  ", receipt.id);
  console.log("URL: ", url);
  if (process.env.IRYS_NETWORK !== "devnet") {
    // Mainnet permanent data also resolves on the Arweave gateway.
    console.log("Also:", `https://arweave.net/${receipt.id}`);
  } else {
    console.log("(devnet: this data is deleted after ~60 days, do not use as an NFT uri)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
