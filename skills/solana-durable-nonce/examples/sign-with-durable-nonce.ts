/**
 * sign-with-durable-nonce.ts
 *
 * Offline-style flow: read a nonce account's stored nonce, build an
 * advance-first transaction, sign it now, serialize it, and submit it later,
 * WITHOUT ever fetching a fresh blockhash for the payload.
 *
 * The flow is split into three phases to model the real separation between
 * signing and submission:
 *   1) READ   (online)        : fetch + decode the nonce account.
 *   2) SIGN   (offline-style) : build, set recentBlockhash = stored nonce, sign,
 *                               serialize the signed bytes.
 *   3) SUBMIT (online, later) : deserialize + sendRawTransaction.
 *
 * The two hard rules enforced here:
 *   - Instruction 0 MUST be SystemProgram.nonceAdvance.
 *   - recentBlockhash MUST be the stored nonce, NOT getLatestBlockhash().
 *   - The nonce authority MUST sign (advance requires its signature).
 *
 * The example payload is a tiny SOL self-transfer; replace it with any
 * instruction(s) you need after the advance.
 *
 * Run (devnet recommended):
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   PAYER_SECRET="[...]" \                 # fee payer; also the SOL sender here
 *   NONCE_AUTHORITY_SECRET="[...]" \       # nonce authority (defaults to payer)
 *   NONCE_PUBKEY="<base58 nonce account>" \
 *     npx tsx sign-with-durable-nonce.ts
 *
 * NONCE_PUBKEY is the account created by create-nonce-account.ts.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  NonceAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

function loadKeypair(envVar: string): Keypair | null {
  const raw = process.env[envVar];
  if (!raw) return null;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const payer = loadKeypair("PAYER_SECRET");
  const noncePubkeyStr = process.env.NONCE_PUBKEY;
  if (!payer || !noncePubkeyStr) {
    console.error("Set PAYER_SECRET and NONCE_PUBKEY.");
    process.exit(1);
  }
  const nonceAuthority = loadKeypair("NONCE_AUTHORITY_SECRET") ?? payer;
  const noncePubkey = new PublicKey(noncePubkeyStr);

  // ---- Phase 1: READ (online) ----------------------------------------------
  // Fetch + decode the nonce account. The stored nonce is the durable blockhash.
  const info = await connection.getAccountInfo(noncePubkey);
  if (!info) throw new Error("nonce account not found");
  const nonceAccount = NonceAccount.fromAccountData(info.data);
  const storedNonce = nonceAccount.nonce; // <- use THIS as recentBlockhash

  console.log("Phase 1 READ");
  console.log("  stored nonce:    ", storedNonce);
  console.log("  authority:       ", nonceAccount.authorizedPubkey.toBase58());

  // Sanity: the key that will sign must be the recorded authority.
  if (!nonceAccount.authorizedPubkey.equals(nonceAuthority.publicKey)) {
    throw new Error(
      "NONCE_AUTHORITY_SECRET does not match the account's authority; advance would fail."
    );
  }

  // ---- Phase 2: SIGN (offline-style) ---------------------------------------
  // Build with nonceAdvance as instruction 0, then the real payload.
  const tx = new Transaction();
  tx.add(
    SystemProgram.nonceAdvance({
      noncePubkey,
      authorizedPubkey: nonceAuthority.publicKey,
    })
  );
  // Example payload: a 0.0001 SOL self-transfer. Replace with your instructions.
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: Math.floor(0.0001 * LAMPORTS_PER_SOL),
    })
  );

  // The durable part: recentBlockhash is the STORED nonce, not a fresh blockhash.
  tx.recentBlockhash = storedNonce;
  tx.feePayer = payer.publicKey;

  // Sign with the nonce authority (required by advance) and the fee payer.
  // If authority === payer this is effectively one signer.
  const signers =
    nonceAuthority.publicKey.equals(payer.publicKey)
      ? [payer]
      : [nonceAuthority, payer];
  tx.sign(...signers);

  // Serialize the fully signed bytes. In a real offline flow these bytes would
  // travel from the air-gapped signer to an online submitter, possibly much later.
  const signedBytes = tx.serialize();
  console.log("\nPhase 2 SIGN");
  console.log("  signed bytes:    ", signedBytes.length, "bytes (ready to submit anytime)");

  // ---- Phase 3: SUBMIT (online, later) -------------------------------------
  // No fresh blockhash is fetched. The transaction lands because its
  // recentBlockhash matches the account's current stored nonce.
  const restored = Transaction.from(signedBytes);
  const sig = await connection.sendRawTransaction(restored.serialize());
  console.log("\nPhase 3 SUBMIT");
  console.log("  submitted:       ", sig);

  await connection.confirmTransaction(sig, "confirmed");
  console.log("  confirmed.");

  console.log(
    "\nNote: this submission ADVANCED the nonce. Re-running submit would fail" +
      " (stale nonce). For another durable tx, re-read the stored nonce first."
  );
}

main().catch((e) => {
  console.error("sign-with-durable-nonce failed:", e);
  process.exit(1);
});
