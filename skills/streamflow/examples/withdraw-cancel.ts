/**
 * withdraw-cancel.ts
 *
 * Manage an existing Streamflow stream:
 *   1. read it with getOne (convert BN amounts to human units),
 *   2. WITHDRAW the currently-unlocked amount as the recipient,
 *   3. CANCEL as the sender (returns the still-locked remainder to the sender;
 *      already-unlocked funds stay with the recipient).
 *
 * cancel only works for an invoker the stream marked cancelable
 * (cancelableBySender / cancelableByRecipient). withdraw reverts if you ask for
 * more than is unlocked, so we read the stream first.
 *
 * Run:
 *   npm i -s @streamflow/stream @streamflow/common @solana/web3.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   STREAM_ID=<metadata_pubkey_from_create> \
 *   RECIPIENT_SECRET_KEY='[...]'   # withdraws
 *   SENDER_SECRET_KEY='[...]'      # cancels
 *   DECIMALS=6 \
 *   ACTION=withdraw|cancel|both \
 *     npx tsx withdraw-cancel.ts
 *
 * Confirm @streamflow/stream is v12.x: `npm ls @streamflow/stream`.
 */

import { Keypair } from "@solana/web3.js";
import {
  SolanaStreamClient,
  ICluster,
  getNumberFromBN,
} from "@streamflow/stream";

function loadKey(name: string): Keypair {
  const raw = process.env[name];
  if (!raw) throw new Error(`set ${name} to a JSON array secret key`);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function readStream(
  client: SolanaStreamClient,
  id: string,
  decimals: number
) {
  // getOne returns a typed Stream with depositedAmount / withdrawnAmount as BN.
  const stream = await client.getOne({ id });
  console.log("Stream state:");
  console.log(`  deposited:  ${getNumberFromBN(stream.depositedAmount, decimals)}`);
  console.log(`  withdrawn:  ${getNumberFromBN(stream.withdrawnAmount, decimals)}`);
  return stream;
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const id = process.env.STREAM_ID;
  const decimals = Number(process.env.DECIMALS ?? "6");
  const action = (process.env.ACTION ?? "both").toLowerCase();
  if (!id) throw new Error("set STREAM_ID to the stream's metadata pubkey");

  // Pass ICluster.Devnet so the client targets the devnet program id; it
  // defaults to Mainnet. Switch to ICluster.Mainnet with a mainnet RPC.
  const client = new SolanaStreamClient(rpc, ICluster.Devnet);

  await readStream(client, id, decimals);

  if (action === "withdraw" || action === "both") {
    const recipient = loadKey("RECIPIENT_SECRET_KEY");
    console.log("Withdrawing all currently-unlocked tokens as recipient...");
    // Omitting `amount` withdraws everything currently unlocked.
    const res = await client.withdraw({ id }, { invoker: recipient });
    console.log(`  withdraw tx: ${res.txId}`);
  }

  if (action === "cancel" || action === "both") {
    const sender = loadKey("SENDER_SECRET_KEY");
    console.log("Cancelling as sender; unvested remainder returns to sender...");
    const res = await client.cancel({ id }, { invoker: sender });
    console.log(`  cancel tx:   ${res.txId}`);
  }

  console.log("Final state:");
  await readStream(client, id, decimals);
}

main().catch((e) => {
  console.error("withdraw-cancel failed:", e);
  process.exit(1);
});
