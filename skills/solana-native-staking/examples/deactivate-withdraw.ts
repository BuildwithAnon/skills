/**
 * deactivate-withdraw.ts
 *
 * Unstake a native stake account end to end: deactivate, derive status WITHOUT
 * the deprecated getStakeActivation, wait for the one-epoch cooldown to make the
 * stake INACTIVE, then withdraw the full balance and close the account.
 *
 * connection.getStakeActivation is deprecated in @solana/web3.js and the RPC
 * method behind it has been dropped by validators, so status is derived from the
 * parsed delegation fields (activationEpoch, deactivationEpoch) and the current
 * epoch. The u64::MAX sentinel marks "not deactivated".
 *
 * Run (devnet recommended for testing):
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   AUTHORITY_SECRET_KEY='[12,34,...]' \
 *   STAKE_ACCOUNT=<STAKE_ACCOUNT_PUBKEY> \
 *   DESTINATION=<WALLET_TO_RECEIVE_SOL> \
 *   WAIT=true \
 *     npx tsx deactivate-withdraw.ts
 *
 * AUTHORITY_SECRET_KEY must hold BOTH the stake authority (to deactivate) and
 * the withdraw authority (to withdraw). If they differ in your setup, sign each
 * step with the right key. With WAIT=false the script deactivates and exits
 * without waiting for the cooldown (useful when the epoch is days away).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  StakeProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const NOT_DEACTIVATED = 18446744073709551615n; // u64::MAX sentinel

type StakeStatus =
  | "undelegated"
  | "activating"
  | "active"
  | "deactivating"
  | "inactive";

function loadAuthority(): Keypair {
  const raw = process.env.AUTHORITY_SECRET_KEY;
  if (!raw) {
    console.error("Set AUTHORITY_SECRET_KEY to a JSON array secret key.");
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Derive stake status from the parsed delegation fields plus the current epoch.
 * Replaces the deprecated connection.getStakeActivation. Epoch granularity only:
 * exact mid-epoch warming/cooling lamport splits are not derivable here.
 */
function deriveStatus(
  delegation: { activationEpoch: string; deactivationEpoch: string } | null,
  currentEpoch: bigint
): StakeStatus {
  if (!delegation) return "undelegated";
  const act = BigInt(delegation.activationEpoch);
  const deact = BigInt(delegation.deactivationEpoch);

  if (deact !== NOT_DEACTIVATED) {
    if (deact === currentEpoch) return "deactivating";
    if (deact < currentEpoch) return "inactive";
  }
  if (act === currentEpoch) return "activating";
  if (act < currentEpoch) return "active";
  return "activating";
}

async function readStatus(
  connection: Connection,
  stakeAccount: PublicKey
): Promise<{ status: StakeStatus; epoch: bigint; lamports: number }> {
  const epochInfo = await connection.getEpochInfo();
  const currentEpoch = BigInt(epochInfo.epoch);

  const info = await connection.getParsedAccountInfo(stakeAccount);
  const value = info.value;
  if (!value) {
    return { status: "undelegated", epoch: currentEpoch, lamports: 0 };
  }
  const lamports = value.lamports;

  // Parsed stake account shape: data.parsed.info.stake.delegation (or null).
  const data = value.data as unknown as {
    parsed?: { info?: { stake?: { delegation?: any } | null } };
  };
  const delegation = data.parsed?.info?.stake?.delegation ?? null;

  return {
    status: deriveStatus(
      delegation
        ? {
            activationEpoch: String(delegation.activationEpoch),
            deactivationEpoch: String(delegation.deactivationEpoch),
          }
        : null,
      currentEpoch
    ),
    epoch: currentEpoch,
    lamports,
  };
}

/** Sleep helper for the epoch-boundary wait loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const authority = loadAuthority();

  const stakeEnv = process.env.STAKE_ACCOUNT;
  const destEnv = process.env.DESTINATION;
  if (!stakeEnv || !destEnv) {
    console.error("Set STAKE_ACCOUNT and DESTINATION pubkeys.");
    process.exit(1);
  }
  const stakeAccount = new PublicKey(stakeEnv);
  const destination = new PublicKey(destEnv);
  const wait = (process.env.WAIT ?? "true") !== "false";

  // 1) Read current status.
  let state = await readStatus(connection, stakeAccount);
  console.log(`Stake account:  ${stakeAccount.toBase58()}`);
  console.log(`  epoch:        ${state.epoch}`);
  console.log(`  status:       ${state.status}`);
  console.log(`  balance:      ${state.lamports / LAMPORTS_PER_SOL} SOL`);

  // 2) Deactivate if it is still active/activating.
  if (state.status === "active" || state.status === "activating") {
    console.log("\nDeactivating (stake authority)...");
    const deactivateTx = StakeProgram.deactivate({
      stakePubkey: stakeAccount,
      authorizedPubkey: authority.publicKey,
    });
    const sig = await sendAndConfirmTransaction(connection, deactivateTx, [
      authority,
    ]);
    console.log(`  signature:    ${sig}`);
    console.log(
      "  status:       DEACTIVATING. Withdrawable after the one-epoch cooldown."
    );
    state = await readStatus(connection, stakeAccount);
  } else if (state.status === "inactive") {
    console.log("\nAlready inactive; skipping deactivate.");
  } else if (state.status === "deactivating") {
    console.log("\nAlready deactivating; waiting for cooldown.");
  } else {
    console.log("\nUndelegated; nothing to deactivate.");
  }

  // 3) Wait for the cooldown to complete (status -> inactive), at epoch
  //    granularity. We poll the boundary, not in a tight loop.
  if (state.status !== "inactive" && wait) {
    console.log("\nWaiting for stake to become INACTIVE (next epoch)...");
    while (state.status !== "inactive") {
      await sleep(60_000); // check once a minute; epochs are ~2-3 days
      state = await readStatus(connection, stakeAccount);
      console.log(`  epoch ${state.epoch}: ${state.status}`);
    }
  }

  if (state.status !== "inactive") {
    console.log(
      "\nStake not yet inactive and WAIT=false. Re-run after the cooldown " +
        "epoch to withdraw."
    );
    return;
  }

  // 4) Withdraw the full balance (closes the account), withdraw authority.
  console.log("\nWithdrawing full balance (withdraw authority)...");
  const withdrawTx = StakeProgram.withdraw({
    stakePubkey: stakeAccount,
    authorizedPubkey: authority.publicKey,
    toPubkey: destination,
    lamports: state.lamports, // full balance incl. reserve -> closes account
  });
  const sig = await sendAndConfirmTransaction(connection, withdrawTx, [
    authority,
  ]);

  console.log("\nDone.");
  console.log(`  signature:    ${sig}`);
  console.log(`  withdrew:     ${state.lamports / LAMPORTS_PER_SOL} SOL`);
  console.log(`  to:           ${destination.toBase58()}`);
  console.log("  stake account closed (full balance withdrawn).");
}

main().catch((e) => {
  console.error("deactivate-withdraw failed:", e);
  process.exit(1);
});
