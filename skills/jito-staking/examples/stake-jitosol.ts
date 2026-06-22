/**
 * stake-jitosol.ts
 *
 * Mint JitoSOL by depositing SOL into the Jito SPL Stake Pool.
 *
 * JitoSOL is a standard SPL Stake Pool (no custom program), so this uses
 * @solana/spl-stake-pool on the classic @solana/web3.js Connection.
 *
 * Flow: load pool -> read exchange rate -> update pool if stale this epoch
 *       -> depositSol -> assemble + send.
 *
 * JitoSOL is rewards-bearing: rate = totalLamports / poolTokenSupply is > 1
 * and grows each epoch, so the JitoSOL received is NOT equal to the SOL sent.
 *
 * Run:
 *   npm i @solana/web3.js @solana/spl-stake-pool@1.1.8
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *   KEYPAIR_PATH=~/.config/solana/id.json \
 *     npx tsx stake-jitosol.ts <SOL_AMOUNT>
 *
 * Example: stake 1 SOL
 *   npx tsx stake-jitosol.ts 1
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Signer,
} from "@solana/web3.js";
import {
  getStakePoolAccount,
  updateStakePool,
  depositSol,
} from "@solana/spl-stake-pool";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const JITO_STAKE_POOL = new PublicKey(
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"
);

function loadKeypair(path: string): Keypair {
  const resolved = path.startsWith("~") ? path.replace("~", homedir()) : path;
  const secret = JSON.parse(readFileSync(resolved, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

/** Send one Transaction built from a set of instructions + extra signers. */
async function sendIxs(
  connection: Connection,
  payer: Keypair,
  instructions: any[],
  extraSigners: Signer[] = []
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  const signers: Signer[] = [payer, ...extraSigners];
  return sendAndConfirmTransaction(connection, tx, signers, {
    commitment: "confirmed",
  });
}

async function main() {
  const solArg = process.argv[2];
  if (!solArg) {
    console.error("Usage: npx tsx stake-jitosol.ts <SOL_AMOUNT>");
    process.exit(1);
  }
  // depositSol takes lamports as a number (base units) in @solana/spl-stake-pool.
  const lamports = Math.round(Number(solArg) * LAMPORTS_PER_SOL);

  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const payer = loadKeypair(
    process.env.KEYPAIR_PATH ?? "~/.config/solana/id.json"
  );

  // Step 1: load the pool and read the exchange rate.
  const pool = await getStakePoolAccount(connection, JITO_STAKE_POOL);
  const totalLamports = BigInt(pool.account.data.totalLamports.toString());
  const poolTokenSupply = BigInt(pool.account.data.poolTokenSupply.toString());
  const rate =
    poolTokenSupply === 0n ? 1 : Number(totalLamports) / Number(poolTokenSupply);
  const estJitoSol = Number(lamports) / rate / LAMPORTS_PER_SOL;

  console.log(`JitoSOL/SOL rate:  ~${rate.toFixed(6)} (rewards-bearing, > 1)`);
  console.log(`Depositing:        ${solArg} SOL (${lamports} lamports)`);
  console.log(`Est. JitoSOL out:  ~${estJitoSol.toFixed(6)} (NOT 1:1)`);

  // Step 2: update the pool if it is stale this epoch, or deposit can fail.
  const epochInfo = await connection.getEpochInfo();
  const lastUpdateEpoch = Number(pool.account.data.lastUpdateEpoch.toString());
  if (lastUpdateEpoch < epochInfo.epoch) {
    console.log(
      `Pool stale (lastUpdateEpoch=${lastUpdateEpoch} < ${epochInfo.epoch}); updating...`
    );
    // updateStakePool returns { updateListInstructions, finalInstructions }
    // (both TransactionInstruction[]) in @solana/spl-stake-pool@1.1.8.
    const update = await updateStakePool(connection, pool);
    for (const ix of update.updateListInstructions) {
      await sendIxs(connection, payer, [ix]);
    }
    await sendIxs(connection, payer, update.finalInstructions);
    console.log("Pool updated.");
  }

  // Step 3: deposit SOL, mint JitoSOL.
  const { instructions, signers } = await depositSol(
    connection,
    JITO_STAKE_POOL,
    payer.publicKey,
    lamports
  );
  const sig = await sendIxs(connection, payer, instructions, signers as Signer[]);

  console.log("\nDONE");
  console.log(`  signature: ${sig}`);
  console.log(`  staked:    ${solArg} SOL -> ~${estJitoSol.toFixed(6)} JitoSOL`);
}

main().catch((e) => {
  console.error("stake-jitosol failed:", e);
  process.exit(1);
});
