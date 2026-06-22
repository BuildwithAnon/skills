/**
 * Wrap native SOL into Wrapped SOL (WSOL) and unwrap it back.
 *
 * Wrapping = make SOL usable as an SPL token (many AMMs and programs expect WSOL):
 *   1. Idempotently create the WSOL ATA (WSOL uses the CLASSIC Token program).
 *   2. SystemProgram.transfer lamports into that ATA.
 *   3. createSyncNativeInstruction so the token balance reflects the lamports.
 *
 * Unwrapping = turn WSOL back into native SOL:
 *   - createCloseAccountInstruction on the WSOL ATA returns the wrapped lamports
 *     AND the account rent to the destination, in one instruction.
 *
 * Run on devnet:
 *   npm i @solana/web3.js @solana/spl-token
 *   npx ts-node wrap-unwrap-sol.ts
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  clusterApiUrl,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  NATIVE_MINT, // So11111111111111111111111111111111111111112
  TOKEN_PROGRAM_ID, // WSOL is a classic Token program mint
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  getAccount,
} from "@solana/spl-token";

// How much SOL to wrap into WSOL, in lamports. 0.5 SOL here.
const WRAP_LAMPORTS = BigInt(0.5 * LAMPORTS_PER_SOL);

async function main() {
  const connection = new Connection(clusterApiUrl("devnet"), "confirmed");

  const owner = Keypair.generate();
  await airdrop(connection, owner.publicKey);

  // WSOL ATA. WSOL uses the classic Token program, so pass TOKEN_PROGRAM_ID.
  const wsolAta = getAssociatedTokenAddressSync(
    NATIVE_MINT,
    owner.publicKey,
    false,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  console.log("WSOL ATA:", wsolAta.toBase58());

  // --- WRAP ---
  // (1) create the ATA idempotently, (2) move lamports in, (3) syncNative so the
  // token balance picks up the lamports. All three in one transaction.
  const wrapTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey, // payer of the ~0.00204 SOL account rent
      wsolAta,
      owner.publicKey, // ATA owner
      NATIVE_MINT,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: wsolAta,
      lamports: WRAP_LAMPORTS,
    }),
    createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID)
  );
  const wrapSig = await sendAndConfirmTransaction(connection, wrapTx, [owner]);
  console.log("wrap tx:", wrapSig);

  const wrapped = await getAccount(connection, wsolAta, "confirmed", TOKEN_PROGRAM_ID);
  console.log("WSOL token balance:", wrapped.amount.toString());
  // wrapped.amount should equal WRAP_LAMPORTS (WSOL has 9 decimals, like SOL).

  // ... use WSOL like any SPL token here (deposit to an AMM, swap, etc.) ...

  // --- UNWRAP ---
  // Close the WSOL ATA. This returns BOTH the wrapped lamports and the account
  // rent to the destination. No need to zero the balance first for WSOL: closing
  // a native account converts its balance back to lamports automatically.
  const solBefore = await connection.getBalance(owner.publicKey);

  const unwrapTx = new Transaction().add(
    createCloseAccountInstruction(
      wsolAta,
      owner.publicKey, // destination for the reclaimed lamports + rent
      owner.publicKey, // account owner / authority
      [],
      TOKEN_PROGRAM_ID
    )
  );
  const unwrapSig = await sendAndConfirmTransaction(connection, unwrapTx, [owner]);
  console.log("unwrap tx:", unwrapSig);

  const solAfter = await connection.getBalance(owner.publicKey);
  console.log("SOL gained from unwrap (lamports):", solAfter - solBefore);
  // Net gain is roughly WRAP_LAMPORTS + the ~0.00204 SOL account rent, minus the
  // transaction fee for this close transaction.

  // The WSOL ATA no longer exists after closing.
  const stillThere = await connection.getAccountInfo(wsolAta);
  console.log("WSOL ATA exists after close:", stillThere !== null);
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
