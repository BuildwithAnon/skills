/**
 * create-delegate.ts
 *
 * Create a native Solana stake account and delegate it to a validator vote
 * account in a single transaction.
 *
 * Funds the account with the rent-exempt reserve PLUS the lamports to stake,
 * checks the delegated amount against the network minimum delegation, then
 * delegates. After this lands the stake is ACTIVATING and becomes ACTIVE at the
 * next epoch boundary (one-epoch warmup): this script does NOT claim it is
 * active immediately.
 *
 * Run (devnet recommended for testing):
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   PAYER_SECRET_KEY='[12,34,...]' \
 *   VOTE_ACCOUNT=<VALIDATOR_VOTE_PUBKEY> \
 *   STAKE_SOL=2 \
 *     npx tsx create-delegate.ts
 *
 * PAYER_SECRET_KEY is a JSON array (the format `solana-keygen` writes). The
 * payer also acts as both the stake authority and the withdraw authority here;
 * in production point the withdraw authority at a cold wallet (see Step 10 in
 * SKILL.md and StakeProgram.authorize).
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  Authorized,
  Lockup,
  StakeProgram,
  LAMPORTS_PER_SOL,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

function loadPayer(): Keypair {
  const raw = process.env.PAYER_SECRET_KEY;
  if (!raw) {
    console.error("Set PAYER_SECRET_KEY to a JSON array secret key.");
    process.exit(1);
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

/**
 * Fetch the network minimum delegation in lamports. getStakeMinimumDelegation
 * is present in recent @solana/web3.js; if your version lacks it, fall back to
 * the 1 SOL floor and surface that you assumed it.
 */
async function getMinimumDelegation(connection: Connection): Promise<number> {
  const anyConn = connection as unknown as {
    getStakeMinimumDelegation?: () => Promise<{ value: number }>;
  };
  if (typeof anyConn.getStakeMinimumDelegation === "function") {
    const res = await anyConn.getStakeMinimumDelegation();
    return res.value;
  }
  console.warn(
    "getStakeMinimumDelegation unavailable; assuming 1 SOL minimum delegation."
  );
  return LAMPORTS_PER_SOL;
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const payer = loadPayer();
  const voteEnv = process.env.VOTE_ACCOUNT;
  if (!voteEnv) {
    console.error("Set VOTE_ACCOUNT to a validator vote account pubkey.");
    process.exit(1);
  }
  const voteAccount = new PublicKey(voteEnv);

  const stakeSol = Number(process.env.STAKE_SOL ?? "2");
  const stakeLamports = Math.round(stakeSol * LAMPORTS_PER_SOL);

  // 1) Rent-exempt reserve for a stake account, plus the stake itself.
  const rentExempt = await connection.getMinimumBalanceForRentExemption(
    StakeProgram.space
  );
  const lamports = rentExempt + stakeLamports;

  // 2) Delegated portion must meet the network minimum delegation.
  const minDelegation = await getMinimumDelegation(connection);
  if (stakeLamports < minDelegation) {
    console.error(
      `Stake ${stakeLamports} lamports is below minimum delegation ${minDelegation} lamports ` +
        `(${minDelegation / LAMPORTS_PER_SOL} SOL). Increase STAKE_SOL.`
    );
    process.exit(1);
  }

  // Payer is stake authority + withdraw authority here.
  const stakeAuthority = payer.publicKey;
  const withdrawAuthority = payer.publicKey;

  // 3) Fresh stake account keypair (must sign its own creation).
  const stakeAccount = Keypair.generate();

  const createIx = StakeProgram.createAccount({
    fromPubkey: payer.publicKey,
    stakePubkey: stakeAccount.publicKey,
    authorized: new Authorized(stakeAuthority, withdrawAuthority),
    lockup: new Lockup(0, 0, PublicKey.default), // no lockup
    lamports, // rent reserve + stake
  });

  // 4) Delegate to the validator vote account, signed by the stake authority.
  const delegateIx = StakeProgram.delegate({
    stakePubkey: stakeAccount.publicKey,
    authorizedPubkey: stakeAuthority,
    votePubkey: voteAccount,
  });

  // createAccount returns a Transaction; pull its instructions into one tx.
  const tx = new Transaction();
  tx.add(...createIx.instructions, ...delegateIx.instructions);

  console.log("Creating + delegating stake account...");
  console.log(`  stake account:   ${stakeAccount.publicKey.toBase58()}`);
  console.log(`  vote account:    ${voteAccount.toBase58()}`);
  console.log(`  rent reserve:    ${rentExempt / LAMPORTS_PER_SOL} SOL`);
  console.log(`  delegated:       ${stakeLamports / LAMPORTS_PER_SOL} SOL`);
  console.log(`  total funded:    ${lamports / LAMPORTS_PER_SOL} SOL`);

  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer, // payer + authority signature
    stakeAccount, // new account signs its creation
  ]);

  const epochInfo = await connection.getEpochInfo();
  console.log("\nDone.");
  console.log(`  signature:       ${sig}`);
  console.log(`  current epoch:   ${epochInfo.epoch}`);
  console.log(
    "  status:          ACTIVATING (warming up this epoch). Becomes ACTIVE " +
      "at the next epoch boundary, not immediately."
  );
}

main().catch((e) => {
  console.error("create-delegate failed:", e);
  process.exit(1);
});
