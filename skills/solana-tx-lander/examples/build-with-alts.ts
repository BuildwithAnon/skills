/**
 * build-with-alts.ts
 *
 * Build a v0 VersionedTransaction that fits a LARGE instruction set under the
 * 1232-byte packet limit by using an Address Lookup Table (ALT).
 *
 * Without an ALT, every account reference costs 32 bytes in the message. A
 * transaction touching many distinct accounts blows past 1232 bytes and the RPC
 * rejects it as "Transaction too large". An ALT stores those accounts on-chain
 * once; the transaction then references each by a 1-byte index, which collapses
 * the size dramatically.
 *
 * This file shows both halves:
 *   A) create + extend an ALT (one-time setup, then wait a slot for activation), and
 *   B) compile a v0 transaction that resolves accounts through that ALT and
 *      verify the serialized size is under 1232 bytes.
 *
 * After building, hand the transaction to the land-transaction flow (simulate,
 * size, price, send, expiry-aware confirm). This file focuses on the ALT build.
 *
 *   npm i @solana/web3.js
 *   export RPC_URL="https://api.devnet.solana.com"
 *   export SECRET_KEY="[12,34,...]"   # JSON array of the payer secret key
 *   npx tsx build-with-alts.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- A) create and populate an Address Lookup Table -------------------------

/**
 * Create a new ALT and extend it with the given addresses. Returns the ALT
 * address. The ALT is only usable one slot AFTER the extend lands, so callers
 * must wait before compiling a transaction that uses it.
 */
async function createLookupTable(
  connection: Connection,
  payer: Keypair,
  addresses: PublicKey[]
): Promise<PublicKey> {
  const slot = await connection.getSlot("confirmed");

  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: slot,
    });

  // Extend can hold many addresses, but each extend instruction is itself a tx
  // bounded by 1232 bytes, so add at most ~20-30 addresses per extend call.
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: lookupTableAddress,
    addresses,
  });

  await sendV0(connection, payer, [createIx, extendIx]);
  return lookupTableAddress;
}

/** Fetch an ALT account, waiting until it is on-chain and active. */
async function fetchLookupTable(
  connection: Connection,
  lookupTableAddress: PublicKey
): Promise<AddressLookupTableAccount> {
  for (let i = 0; i < 10; i++) {
    const res = await connection.getAddressLookupTable(lookupTableAddress);
    if (res.value) return res.value;
    await sleep(1000); // wait for the table to become visible/active
  }
  throw new Error("lookup table not available: " + lookupTableAddress.toBase58());
}

// ---- B) compile a large v0 transaction through the ALT ----------------------

/**
 * Compile a v0 VersionedTransaction whose accounts resolve through the ALT, and
 * assert it fits under 1232 bytes.
 */
async function buildWithAlt(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[]
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables); // <-- ALT resolution happens here

  const tx = new VersionedTransaction(message);
  tx.sign([payer]);

  const size = tx.serialize().length;
  console.log("serialized size:", size, "bytes (limit 1232)");
  if (size > 1232) {
    throw new Error(
      `still ${size} bytes. Add more accounts to the ALT, or split across more lookup tables.`
    );
  }
  return tx;
}

// ---- shared: send a v0 transaction (used for ALT setup) --------------------

async function sendV0(
  connection: Connection,
  payer: Keypair,
  instructions: TransactionInstruction[]
): Promise<string> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 0,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  return sig;
}

// ---- runnable demo ---------------------------------------------------------

async function main() {
  const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(RPC_URL, "confirmed");

  const payer = process.env.SECRET_KEY
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SECRET_KEY)))
    : Keypair.generate();

  // Simulate a "large" instruction set: many distinct recipients. Without an
  // ALT, ~20 transfers to distinct accounts overflow the 1232-byte limit.
  const recipients = Array.from({ length: 20 }, () => Keypair.generate().publicKey);

  const transferIxs: TransactionInstruction[] = recipients.map((to) =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: to,
      lamports: Math.floor(0.0001 * LAMPORTS_PER_SOL),
    })
  );

  // 1. Put the repeated accounts into an ALT (payer + every recipient).
  console.log("creating lookup table with", recipients.length + 1, "addresses...");
  const altAddress = await createLookupTable(connection, payer, [
    payer.publicKey,
    ...recipients,
  ]);
  console.log("lookup table   :", altAddress.toBase58());

  // 2. Wait for activation, then fetch it.
  await sleep(2000);
  const alt = await fetchLookupTable(connection, altAddress);

  // 3. Compile the large transaction through the ALT and verify it fits.
  const tx = await buildWithAlt(connection, payer, transferIxs, [alt]);
  console.log("built v0 tx with", transferIxs.length, "instructions, fits under 1232 bytes.");

  // From here, run the normal land-transaction flow (simulate, size, price,
  // send with maxRetries:0, expiry-aware confirm) on `tx`'s instructions.
  void tx;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
