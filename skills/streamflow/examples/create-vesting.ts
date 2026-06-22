/**
 * create-vesting.ts
 *
 * Create a token VESTING stream on Solana with Streamflow: a fixed total locked
 * once and unlocked linearly after a cliff. This is the team/investor/advisor
 * pattern (canTopup: false, so the total cannot change later).
 *
 * Demonstrated gotchas:
 *   - amounts are BN in SMALLEST units    -> getBN(value, decimals)
 *   - timestamps are UNIX SECONDS not ms  -> Math.floor(Date.now() / 1000)
 *   - the stream id is metadata's pubkey  -> persist it for later calls
 *   - the sender pays the 0.25% fee + rents
 *
 * Run:
 *   npm i -s @streamflow/stream @streamflow/common @solana/web3.js bn.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   SENDER_SECRET_KEY='[12,34,...]'   # JSON array of the 64-byte secret key
 *   RECIPIENT=<recipient_pubkey> \
 *   MINT=<spl_mint_pubkey> \
 *   DECIMALS=6 \
 *     npx tsx create-vesting.ts
 *
 * Use a devnet RPC and the devnet program (the SDK picks the program id from the
 * cluster) while testing. Built against @streamflow/stream@12.4.0.
 */

import { Keypair } from "@solana/web3.js";
import {
  SolanaStreamClient,
  ICluster,
  getBN,
  getNumberFromBN,
  type ICreateStreamData,
} from "@streamflow/stream";

// 30 days in seconds, used as the unlock period and (x6) the cliff offset.
const THIRTY_DAYS = 30 * 24 * 60 * 60;

function loadSender(): Keypair {
  const raw = process.env.SENDER_SECRET_KEY;
  if (!raw) throw new Error("set SENDER_SECRET_KEY to a JSON array secret key");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Build a 24-month vesting schedule with a 6-month cliff.
 * Total = 1,000,000 tokens. Cliff releases 6/24 (250,000) at month 6, the
 * remaining 750,000 unlock over 18 monthly periods. We compute amountPerPeriod
 * and push any rounding remainder into the cliff so the parts sum to the total.
 */
function buildVestingData(
  recipient: string,
  mint: string,
  decimals: number
): ICreateStreamData {
  const now = Math.floor(Date.now() / 1000); // UNIX SECONDS, never Date.now()
  const total = 1_000_000;
  const cliffMonths = 6;
  const totalMonths = 24;
  const periodsAfterCliff = totalMonths - cliffMonths; // 18

  // Base cliff share, then distribute the rest over the remaining periods.
  const cliffShare = Math.floor((total * cliffMonths) / totalMonths); // 250,000
  const remaining = total - cliffShare; // 750,000
  const perPeriod = Math.floor(remaining / periodsAfterCliff); // 41,666
  const distributed = perPeriod * periodsAfterCliff; // 749,988
  // Push the rounding remainder into the cliff so everything sums to `total`.
  const cliffAmount = cliffShare + (remaining - distributed); // 250,012

  const start = now; // unlock clock starts now
  const cliff = now + cliffMonths * THIRTY_DAYS; // cliff unlocks at month 6

  return {
    recipient,
    tokenId: mint,
    start,
    amount: getBN(total, decimals), // BN in smallest units
    period: THIRTY_DAYS, // one unlock step per 30 days
    cliff,
    cliffAmount: getBN(cliffAmount, decimals),
    amountPerPeriod: getBN(perPeriod, decimals),
    name: "Team vesting (24mo, 6mo cliff)",
    canTopup: false, // VESTING: total is fixed, topup disabled
    canUpdateRate: false,
    cancelableBySender: true, // sender can cancel and reclaim the unvested remainder
    cancelableByRecipient: false,
    transferableBySender: false,
    transferableByRecipient: true,
    automaticWithdrawal: false, // recipient calls withdraw; no ~0.19 SOL auto fee
    // withdrawalFrequency is REQUIRED only when automaticWithdrawal is true
  };
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const recipient = process.env.RECIPIENT;
  const mint = process.env.MINT;
  const decimals = Number(process.env.DECIMALS ?? "6");
  if (!recipient || !mint) {
    throw new Error("set RECIPIENT and MINT env vars");
  }

  const sender = loadSender();
  // Pass ICluster.Devnet so the client targets the devnet program id; it
  // defaults to Mainnet. Switch to ICluster.Mainnet with a mainnet RPC.
  const client = new SolanaStreamClient(rpc, ICluster.Devnet);

  const data = buildVestingData(recipient, mint, decimals);

  console.log("Creating vesting stream:");
  console.log(`  recipient:        ${recipient}`);
  console.log(`  mint:             ${mint}`);
  console.log(`  total:            ${getNumberFromBN(data.amount, decimals)}`);
  console.log(`  cliff amount:     ${getNumberFromBN(data.cliffAmount, decimals)}`);
  console.log(`  per period:       ${getNumberFromBN(data.amountPerPeriod, decimals)}`);
  console.log(`  start (unix s):   ${data.start}`);
  console.log(`  cliff (unix s):   ${data.cliff}`);
  console.log(
    "  note: 0.25% protocol fee is taken at creation, so the recipient nets ~99.75%."
  );

  // create(data, { sender, isNative }) returns { ixs, txId, metadataId }.
  // `metadataId` is the new stream's id (the metadata account pubkey).
  const { ixs, txId, metadataId } = await client.create(data, {
    sender,
    isNative: false, // SPL token; set true only to stream native SOL
  });

  // The stream id is the metadata account pubkey. PERSIST IT for withdraw/cancel/etc.
  console.log("Stream created.");
  console.log(`  instructions:     ${ixs.length}`);
  console.log(`  tx:               ${txId}`);
  console.log(`  stream id:        ${metadataId}  <-- save this`);
}

main().catch((e) => {
  console.error("create-vesting failed:", e);
  process.exit(1);
});
