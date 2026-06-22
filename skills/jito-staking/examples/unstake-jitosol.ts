/**
 * unstake-jitosol.ts
 *
 * Redeem JitoSOL back to SOL via the DELAYED path (withdrawStake).
 *
 * Why delayed: withdrawSol (instant, from the pool reserve) is USUALLY BLOCKED
 * on the Jito pool. The supported exit is withdrawStake, which burns JitoSOL and
 * returns a native stake account. That account must be deactivated, wait ~1 epoch
 * for cooldown, then withdrawn to SOL with the native Stake program.
 *
 * For an INSTANT JitoSOL exit, use a secondary market (Jupiter / Sanctum), not
 * this pool: that is the `sanctum` skill, not this one.
 *
 * Flow:
 *   Phase A (now):   update pool if stale -> withdrawStake -> get a stake account
 *                    -> StakeProgram.deactivate the stake account.
 *   Phase B (later): after ~1 epoch cooldown -> StakeProgram.withdraw to SOL.
 *
 * Run:
 *   npm i @solana/web3.js @solana/spl-stake-pool@1.1.8
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *   KEYPAIR_PATH=~/.config/solana/id.json \
 *     npx tsx unstake-jitosol.ts withdraw <JITOSOL_AMOUNT>
 *     npx tsx unstake-jitosol.ts finish <STAKE_ACCOUNT_PUBKEY>
 *
 * Example:
 *   npx tsx unstake-jitosol.ts withdraw 0.5
 *   # ...wait ~1 epoch...
 *   npx tsx unstake-jitosol.ts finish <STAKE_ACCOUNT_PUBKEY>
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  StakeProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  Signer,
} from "@solana/web3.js";
import {
  getStakePoolAccount,
  updateStakePool,
  withdrawStake,
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

async function sendIxs(
  connection: Connection,
  payer: Keypair,
  instructions: any[],
  extraSigners: Signer[] = []
): Promise<string> {
  const tx = new Transaction().add(...instructions);
  return sendAndConfirmTransaction(connection, tx, [payer, ...extraSigners], {
    commitment: "confirmed",
  });
}

/** Phase A: burn JitoSOL -> stake account, then deactivate it. */
async function withdrawPhase(
  connection: Connection,
  payer: Keypair,
  jitoSolAmount: number
) {
  const pool = await getStakePoolAccount(connection, JITO_STAKE_POOL);

  // Update the pool if stale this epoch, or withdraw can fail.
  const epochInfo = await connection.getEpochInfo();
  const lastUpdateEpoch = Number(pool.account.data.lastUpdateEpoch.toString());
  if (lastUpdateEpoch < epochInfo.epoch) {
    const update = await updateStakePool(connection, pool);
    for (const ix of update.updateListInstructions) {
      await sendIxs(connection, payer, [ix]);
    }
    await sendIxs(connection, payer, update.finalInstructions);
  }

  // JitoSOL (pool-token) amount in base units (9 decimals). withdrawStake takes
  // this amount as a number in @solana/spl-stake-pool.
  const poolTokenAmount = Math.round(jitoSolAmount * LAMPORTS_PER_SOL);

  // withdrawStake returns { instructions, signers, stakeReceiver, ... }. When no
  // stakeReceiver is passed in (as here), the SDK generates the destination stake
  // account internally and returns its pubkey as `stakeReceiver` (and includes its
  // keypair among `signers`). Use the returned `stakeReceiver` directly: signers
  // also contains the SDK's transfer-authority keypair, so do NOT try to pick the
  // stake account out of signers by elimination.
  const { instructions, signers, stakeReceiver } = await withdrawStake(
    connection,
    JITO_STAKE_POOL,
    payer.publicKey,
    poolTokenAmount
  );
  const sig = await sendIxs(connection, payer, instructions, signers as Signer[]);

  const stakeAccount = stakeReceiver;

  console.log("WITHDRAW (phase A) DONE");
  console.log(`  signature:     ${sig}`);
  console.log(`  stake account: ${stakeAccount?.toBase58() ?? "(inspect tx)"}`);

  // Deactivate the returned stake account now so cooldown starts immediately.
  if (stakeAccount) {
    const deactivateTx = StakeProgram.deactivate({
      stakePubkey: stakeAccount,
      authorizedPubkey: payer.publicKey,
    });
    const dsig = await sendAndConfirmTransaction(
      connection,
      new Transaction().add(...deactivateTx.instructions),
      [payer],
      { commitment: "confirmed" }
    );
    console.log(`  deactivated:   ${dsig}`);
    console.log(
      `\n  Next: wait ~1 epoch for cooldown, then:\n    npx tsx unstake-jitosol.ts finish ${stakeAccount.toBase58()}`
    );
  }
}

/** Phase B: after cooldown, withdraw the inactive stake account to SOL. */
async function finishPhase(
  connection: Connection,
  payer: Keypair,
  stakeAccount: PublicKey
) {
  const info = await connection.getAccountInfo(stakeAccount);
  if (!info) {
    console.error("Stake account not found (already withdrawn?).");
    process.exit(1);
  }
  const lamports = info.lamports;

  // Withdraw the full balance to the wallet. Requires the stake to be inactive
  // (deactivation cooldown elapsed); otherwise this reverts.
  const withdrawTx = StakeProgram.withdraw({
    stakePubkey: stakeAccount,
    authorizedPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports,
  });
  const sig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(...withdrawTx.instructions),
    [payer],
    { commitment: "confirmed" }
  );

  console.log("FINISH (phase B) DONE");
  console.log(`  signature: ${sig}`);
  console.log(`  withdrew:  ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
}

async function main() {
  const mode = process.argv[2];
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");
  const payer = loadKeypair(
    process.env.KEYPAIR_PATH ?? "~/.config/solana/id.json"
  );

  if (mode === "withdraw") {
    const amount = Number(process.argv[3]);
    if (!amount) {
      console.error("Usage: npx tsx unstake-jitosol.ts withdraw <JITOSOL_AMOUNT>");
      process.exit(1);
    }
    await withdrawPhase(connection, payer, amount);
  } else if (mode === "finish") {
    const acct = process.argv[3];
    if (!acct) {
      console.error(
        "Usage: npx tsx unstake-jitosol.ts finish <STAKE_ACCOUNT_PUBKEY>"
      );
      process.exit(1);
    }
    await finishPhase(connection, payer, new PublicKey(acct));
  } else {
    console.error(
      "Usage:\n  npx tsx unstake-jitosol.ts withdraw <JITOSOL_AMOUNT>\n  npx tsx unstake-jitosol.ts finish <STAKE_ACCOUNT_PUBKEY>"
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("unstake-jitosol failed:", e);
  process.exit(1);
});
