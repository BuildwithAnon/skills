/**
 * land-transaction.ts
 *
 * The RPC-agnostic procedure to reliably LAND a Solana transaction under
 * congestion, using only standard @solana/web3.js:
 *
 *   1. Build a v0 VersionedTransaction from caller-supplied instructions.
 *   2. Simulate (sigVerify:false, replaceRecentBlockhash:true) to measure CUs.
 *   3. Size compute: setComputeUnitLimit + setLoadedAccountsDataSizeLimit.
 *   4. Set the priority fee price (microLamports). The PRICE VALUE itself is the
 *      job of the priority-fees skill; here it is a caller-supplied number.
 *   5. Sign once and send with skipPreflight:true, maxRetries:0 (we own retries).
 *   6. Confirm with an expiry-aware loop: poll getSignatureStatuses, rebroadcast
 *      the SAME signed bytes, and give up only when getBlockHeight passes
 *      lastValidBlockHeight (DROPPED). A landed status with err != null is
 *      REVERTED (hand off to solana-tx-doctor, do NOT resend).
 *
 * Returns a typed result: confirmed | reverted | dropped.
 *
 *   npm i @solana/web3.js
 *   export RPC_URL="https://api.devnet.solana.com"   # prefer a staked/paid RPC on mainnet
 *   export SECRET_KEY="[12,34,...]"                   # JSON array of the signer secret key
 *   export RECIPIENT="<base58 pubkey>"                # optional
 *   npx tsx land-transaction.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

// ---- result types ----------------------------------------------------------

export type LandResult =
  | { status: "confirmed"; signature: string; slot: number }
  | { status: "reverted"; signature: string; err: unknown } // landed but failed on-chain
  | { status: "dropped"; lastSignature: string }; // blockhash expired, never executed

// ---- tuning ----------------------------------------------------------------

const CU_HEADROOM = 1.1; // ~10% over measured usage
const POLL_INTERVAL_MS = 2_000; // status poll cadence
const REBROADCAST_EVERY_N_POLLS = 2; // rebroadcast every ~4s
const HARD_TIMEOUT_MS = 90_000; // wall-clock guard in case getBlockHeight stalls

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The Compute Budget program id and the SetLoadedAccountsDataSizeLimit
// instruction discriminator (variant 4). @solana/web3.js v1 has no builder for
// this instruction (ComputeBudgetProgram only exposes setComputeUnitLimit and
// setComputeUnitPrice), so build the raw TransactionInstruction ourselves: a
// u8 discriminator (4) followed by a u32-LE byte count.
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  "ComputeBudget111111111111111111111111111111"
);

function setLoadedAccountsDataSizeLimit(bytes: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(4, 0); // SetLoadedAccountsDataSizeLimit discriminator
  data.writeUInt32LE(bytes, 1); // accountDataSizeLimit (u32 LE)
  return new TransactionInstruction({
    programId: COMPUTE_BUDGET_PROGRAM_ID,
    keys: [],
    data,
  });
}

// ---- core: land a transaction ----------------------------------------------

/**
 * Build, simulate, size, price, send, and confirm a transaction with an
 * expiry-aware retry loop.
 *
 * @param connection         a Connection (prefer a staked/paid RPC on mainnet)
 * @param payer              the fee-paying signer
 * @param bodyInstructions   the real program instructions (NO compute-budget ix)
 * @param microLamports      priority-fee price per CU. Choose this with the
 *                           priority-fees skill; never hardcode it for production.
 * @param signers            any extra signers besides the payer
 * @param lookupTables       address lookup tables when the account set is large
 * @param commitment         success threshold ("confirmed" default, "finalized" for high-value)
 */
export async function landTransaction(
  connection: Connection,
  payer: Keypair,
  bodyInstructions: TransactionInstruction[],
  microLamports: number,
  signers: Keypair[] = [],
  lookupTables: AddressLookupTableAccount[] = [],
  commitment: "confirmed" | "finalized" = "confirmed"
): Promise<LandResult> {
  // 1. Fresh blockhash. The SAME blockhash drives the tx and the expiry tracking.
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash(commitment);

  // 2. Simulate the body (compiled with a placeholder CU price so the sim
  //    accounts for the compute-budget instructions too). sigVerify:false lets
  //    us simulate unsigned; replaceRecentBlockhash:true avoids "blockhash not found".
  const simIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...bodyInstructions,
  ];
  const simTx = compileV0(payer.publicKey, blockhash, simIxs, lookupTables);
  const sim = await connection.simulateTransaction(simTx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
  });
  if (sim.value.err) {
    // A simulation error is a build bug, not congestion. Surface it.
    throw new Error("simulation failed: " + JSON.stringify(sim.value.err));
  }
  const unitsConsumed = sim.value.unitsConsumed ?? 0;
  const cuLimit = unitsConsumed > 0 ? Math.ceil(unitsConsumed * CU_HEADROOM) : 1_000;

  // 3. Size the loaded-accounts-data-size limit to the real account footprint.
  //    Default is 64MB and silently wastes compute, so cap it to what we load.
  const dataSizeLimit = await measureLoadedDataSize(
    connection,
    payer.publicKey,
    bodyInstructions
  );

  // 4. Assemble final instructions: CU limit, data-size limit, CU price, then body.
  //    The microLamports value comes from the priority-fees skill (deferred).
  const finalIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    setLoadedAccountsDataSizeLimit(dataSizeLimit),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
    ...bodyInstructions,
  ];

  // 5. Compile, sign ONCE, serialize ONCE. We rebroadcast these exact bytes.
  const tx = compileV0(payer.publicKey, blockhash, finalIxs, lookupTables);
  tx.sign([payer, ...signers]);
  const raw = tx.serialize();

  if (raw.length > 1232) {
    throw new Error(
      `serialized tx is ${raw.length} bytes, over the 1232 limit. Use address lookup tables (see build-with-alts.ts).`
    );
  }

  // Send with the RPC's own retry OFF. The confirm loop owns rebroadcast.
  const signature = await connection.sendRawTransaction(raw, {
    skipPreflight: true,
    maxRetries: 0,
  });

  console.log("submitted     :", signature);
  console.log("cuLimit       :", cuLimit, "  dataSizeLimit:", dataSizeLimit, "bytes");
  console.log("microLamports :", microLamports);

  // 6. Expiry-aware confirm + rebroadcast loop.
  return confirmWithRetry(
    connection,
    raw,
    signature,
    lastValidBlockHeight,
    commitment
  );
}

/**
 * Poll getSignatureStatuses, rebroadcast the same signed bytes, and terminate
 * on confirmation, on-chain revert, or blockhash expiry. Never re-signs.
 */
async function confirmWithRetry(
  connection: Connection,
  raw: Uint8Array,
  signature: string,
  lastValidBlockHeight: number,
  commitment: "confirmed" | "finalized"
): Promise<LandResult> {
  const deadline = Date.now() + HARD_TIMEOUT_MS;
  let poll = 0;

  while (Date.now() < deadline) {
    // Check status FIRST: a tx can land in the slot the blockhash expires.
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];

    if (status) {
      if (status.err) {
        // Landed but reverted. Do NOT resend. Hand off to solana-tx-doctor.
        return { status: "reverted", signature, err: status.err };
      }
      const level = status.confirmationStatus;
      if (level === "confirmed" || level === "finalized") {
        if (commitment === "confirmed" || level === "finalized") {
          return { status: "confirmed", signature, slot: status.slot };
        }
      }
    }

    // Has the blockhash expired? If so and nothing landed, it is DROPPED.
    const height = await connection.getBlockHeight(commitment);
    if (height > lastValidBlockHeight && !status) {
      return { status: "dropped", lastSignature: signature };
    }

    // Rebroadcast the SAME signed bytes every few polls. Duplicate sends of an
    // already-landed tx are harmless no-ops, so this is always safe.
    if (poll % REBROADCAST_EVERY_N_POLLS === 0) {
      try {
        await connection.sendRawTransaction(raw, {
          skipPreflight: true,
          maxRetries: 0,
        });
      } catch {
        // Ignore transient send errors; the next poll decides the outcome.
      }
    }

    poll++;
    await sleep(POLL_INTERVAL_MS);
  }

  // Wall-clock guard tripped: treat as dropped (a landed tx would have a status).
  return { status: "dropped", lastSignature: signature };
}

// ---- helpers ---------------------------------------------------------------

/** Compile a v0 VersionedTransaction from instructions + optional lookup tables. */
function compileV0(
  payer: PublicKey,
  blockhash: string,
  instructions: TransactionInstruction[],
  lookupTables: AddressLookupTableAccount[]
): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(lookupTables);
  return new VersionedTransaction(message);
}

/**
 * Sum the on-chain data length of every account the body instructions touch,
 * plus the payer and invoked programs, with ~10% margin. Falls back to a small
 * value rather than the 64MB default.
 */
async function measureLoadedDataSize(
  connection: Connection,
  payer: PublicKey,
  bodyInstructions: TransactionInstruction[]
): Promise<number> {
  const keys = new Set<string>([payer.toBase58()]);
  for (const ix of bodyInstructions) {
    keys.add(ix.programId.toBase58());
    for (const k of ix.keys) keys.add(k.pubkey.toBase58());
  }
  const pubkeys = [...keys].map((k) => new PublicKey(k));
  const infos = await connection.getMultipleAccountsInfo(pubkeys);
  const totalBytes = infos.reduce(
    (sum, info) => sum + (info?.data.length ?? 0),
    0
  );
  // Margin, and a small floor so a brand-new (empty) account set still works.
  return Math.max(Math.ceil(totalBytes * 1.1), 1024);
}

// ---- runnable demo ---------------------------------------------------------

async function main() {
  const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(RPC_URL, "confirmed");

  const payer = process.env.SECRET_KEY
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(process.env.SECRET_KEY)))
    : Keypair.generate();
  const recipient = process.env.RECIPIENT
    ? new PublicKey(process.env.RECIPIENT)
    : Keypair.generate().publicKey;

  // A tiny SOL transfer as the body. Replace with your real instructions.
  const bodyInstructions: TransactionInstruction[] = [
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: Math.floor(0.001 * LAMPORTS_PER_SOL),
    }),
  ];

  // microLamports: in production, get this from the priority-fees skill.
  // 1 is fine on devnet (no real fee market); floor above 0 under congestion.
  const microLamports = 1;

  const result = await landTransaction(
    connection,
    payer,
    bodyInstructions,
    microLamports
  );

  switch (result.status) {
    case "confirmed":
      console.log("CONFIRMED     :", result.signature, "slot", result.slot);
      break;
    case "reverted":
      console.log("REVERTED      :", result.signature, "err", result.err);
      console.log("-> decode with the solana-tx-doctor skill; do NOT resend.");
      process.exitCode = 1;
      break;
    case "dropped":
      console.log("DROPPED       : blockhash expired, never executed.");
      console.log("-> safe to rebuild with a fresh blockhash and re-priced fee.");
      process.exitCode = 1;
      break;
  }
}

// Run the demo only when invoked directly.
if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
