/**
 * Send an SPL token to any wallet, correctly, for any mint.
 *
 * This flow is program-aware and decimals-aware:
 *   1. Detect whether the mint is classic Token or Token-2022 (read mint owner).
 *   2. Derive the recipient ATA with that program id.
 *   3. Idempotently create the recipient ATA so the transfer lands (payer pays rent).
 *   4. Read decimals from the mint and convert the UI amount to base units.
 *   5. transferChecked the right base-unit amount, then read the real balance delta
 *      (a Token-2022 fee mint delivers less than was sent).
 *
 * Run on devnet:
 *   npm i @solana/web3.js @solana/spl-token
 *   npx ts-node transfer-token.ts
 *
 * For mainnet, load a funded keypair from an env var instead of generating one,
 * and pass an existing mint plus recipient instead of creating them.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getMint,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createMint,
  mintTo,
} from "@solana/spl-token";

// What we want to send, in human (UI) units. The script converts this to base units.
const UI_AMOUNT = 25;

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  // --- Devnet setup: payer, a fresh classic mint, and a recipient wallet. ---
  // On mainnet you already have these; skip straight to "TRANSFER FLOW" below.
  const payer = Keypair.generate();
  await airdrop(connection, payer.publicKey);

  const recipient = Keypair.generate().publicKey;

  // Create a 6-decimal classic SPL mint for the demo and fund the payer's ATA.
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey, // mint authority
    null, // freeze authority
    6, // decimals
    undefined,
    undefined,
    TOKEN_PROGRAM_ID
  );
  console.log("demo mint:", mint.toBase58());

  // --- TRANSFER FLOW (works for any mint, classic or Token-2022) ---

  // (1) Detect the mint's token program by reading the mint account owner.
  const programId = await getTokenProgramId(connection, mint);
  console.log("token program:", programId.toBase58());

  // (4, part one) Read decimals from the mint. Never hardcode 9.
  const mintInfo = await getMint(connection, mint, "confirmed", programId);
  const decimals = mintInfo.decimals;
  console.log("decimals:", decimals);

  // (2) Derive both ATAs with the DETECTED program id.
  const sourceAta = getAssociatedTokenAddressSync(
    mint,
    payer.publicKey,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const destAta = getAssociatedTokenAddressSync(
    mint,
    recipient,
    false,
    programId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  // (3) Idempotently create both ATAs. Payer covers the ~0.00204 SOL rent each.
  // The source ATA is created so we can mint demo tokens into it; the dest ATA
  // is created so the transfer has somewhere to land.
  const setupTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      sourceAta,
      payer.publicKey,
      mint,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    createAssociatedTokenAccountIdempotentInstruction(
      payer.publicKey,
      destAta,
      recipient,
      mint,
      programId,
      ASSOCIATED_TOKEN_PROGRAM_ID
    )
  );
  await sendAndConfirmTransaction(connection, setupTx, [payer]);

  // (3b) On a Token-2022 mint with DefaultAccountState=frozen, the new ATA is
  // created FROZEN and transfers into it fail until the freeze authority thaws it.
  // Detect and surface a clear error rather than blindly sending. (No-op for the
  // classic demo mint, which is never frozen by default.)
  const destAcct = await getAccount(connection, destAta, "confirmed", programId);
  if (destAcct.isFrozen) {
    throw new Error(
      "recipient ATA is frozen (mint default-frozen); the freeze authority must thaw it before transfers"
    );
  }

  // Demo only: mint 1,000 tokens into the source ATA so there is a balance to send.
  await mintTo(
    connection,
    payer,
    mint,
    sourceAta,
    payer, // mint authority
    BigInt(1_000 * 10 ** decimals),
    [],
    undefined,
    programId
  );

  // (4, part two) Convert the UI amount to base units using the real decimals.
  // For amounts where float rounding matters, parse a string into base units instead.
  const amount = BigInt(Math.round(UI_AMOUNT * 10 ** decimals));
  console.log(`sending ${UI_AMOUNT} (${amount.toString()} base units)`);

  // Snapshot the recipient balance so we can measure what actually arrives.
  const before = (
    await getAccount(connection, destAta, "confirmed", programId)
  ).amount;

  // (5) transferChecked passes the mint and decimals; the program reverts on a
  // decimals/mint mismatch instead of moving the wrong amount.
  const transferTx = new Transaction().add(
    createTransferCheckedInstruction(
      sourceAta,
      mint,
      destAta,
      payer.publicKey, // owner of the source account
      amount,
      decimals,
      [],
      programId
    )
  );
  const sig = await sendAndConfirmTransaction(connection, transferTx, [payer]);
  console.log("transfer tx:", sig);

  // On a Token-2022 fee mint the recipient gets less than `amount`. Trust the delta.
  const after = (
    await getAccount(connection, destAta, "confirmed", programId)
  ).amount;
  const received = after - before;
  console.log("requested:", amount.toString());
  console.log("actually received (delta):", received.toString());
  if (received !== amount) {
    console.log(
      "note: received < requested, this mint withholds a transfer fee"
    );
  }
}

/** Read the mint account owner to decide classic Token vs Token-2022. */
async function getTokenProgramId(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`not a token mint, owner is ${info.owner.toBase58()}`);
}

async function airdrop(connection: Connection, pubkey: PublicKey) {
  const sig = await connection.requestAirdrop(pubkey, 2 * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash();
  await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
