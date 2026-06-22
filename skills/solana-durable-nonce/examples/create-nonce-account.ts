/**
 * create-nonce-account.ts
 *
 * Create and initialize a durable nonce account, then read back its initial
 * stored nonce and authority.
 *
 * A nonce account is a System-owned account of fixed size (NONCE_ACCOUNT_LENGTH)
 * that must be rent-exempt. Creation is two instructions in ONE transaction:
 *   1) SystemProgram.createAccount  (allocate + fund the account)
 *   2) SystemProgram.nonceInitialize (write the first durable nonce + authority)
 * The transaction is signed by the fee payer AND the new nonce-account keypair.
 *
 * Run (devnet recommended):
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.devnet.solana.com \
 *   PAYER_SECRET="[1,2,3,...]" \          # JSON array of the fee-payer secret key
 *     npx tsx create-nonce-account.ts
 *
 * PAYER_SECRET is the JSON byte array from a Solana keypair file
 * (e.g. the contents of ~/.config/solana/id.json). The payer needs a little
 * SOL for rent + fees; on devnet you can airdrop to it first.
 *
 * The nonce authority defaults to the payer. Pass NONCE_AUTHORITY_SECRET to use
 * a different authority (the only key later allowed to advance/withdraw/reauthorize).
 */

import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  NONCE_ACCOUNT_LENGTH,
  NonceAccount,
  sendAndConfirmTransaction,
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
  if (!payer) {
    console.error("Set PAYER_SECRET to a JSON byte array of the fee-payer secret key.");
    process.exit(1);
  }

  // The nonce authority is the only key allowed to advance/withdraw/reauthorize
  // the nonce later. Default to the payer; override with NONCE_AUTHORITY_SECRET.
  const nonceAuthority = loadKeypair("NONCE_AUTHORITY_SECRET") ?? payer;

  // A brand-new keypair for the nonce account itself (it is a new account being created).
  const nonceAccount = Keypair.generate();

  // Nonce accounts must be rent-exempt for their fixed size.
  const rent = await connection.getMinimumBalanceForRentExemption(
    NONCE_ACCOUNT_LENGTH
  );

  const tx = new Transaction().add(
    // 1) Allocate + fund the account, owned by the System Program.
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: nonceAccount.publicKey,
      lamports: rent,
      space: NONCE_ACCOUNT_LENGTH,
      programId: SystemProgram.programId,
    }),
    // 2) Initialize it: write the first durable nonce and record the authority.
    SystemProgram.nonceInitialize({
      noncePubkey: nonceAccount.publicKey,
      authorizedPubkey: nonceAuthority.publicKey,
    })
  );

  console.log("Creating nonce account:", nonceAccount.publicKey.toBase58());
  console.log("Authority:            ", nonceAuthority.publicKey.toBase58());
  console.log("Rent-exempt lamports: ", rent);

  // Signers: the fee payer AND the new nonce-account keypair (account creation
  // requires the new account to sign). If the authority is a separate key, it
  // does NOT need to sign initialization.
  const sig = await sendAndConfirmTransaction(connection, tx, [
    payer,
    nonceAccount,
  ]);
  console.log("Confirmed:", sig);

  // Read it back and decode the stored nonce.
  const info = await connection.getAccountInfo(nonceAccount.publicKey);
  if (!info) throw new Error("nonce account not found after creation");
  const decoded = NonceAccount.fromAccountData(info.data);

  console.log("\nNonce account ready.");
  console.log("  noncePubkey:     ", nonceAccount.publicKey.toBase58());
  console.log("  authority:       ", decoded.authorizedPubkey.toBase58());
  console.log("  stored nonce:    ", decoded.nonce); // use this as recentBlockhash later
  console.log(
    "\nSave noncePubkey. Use the stored nonce as recentBlockhash in durable transactions."
  );
}

main().catch((e) => {
  console.error("create-nonce-account failed:", e);
  process.exit(1);
});
