/**
 * decode-with-official-primitives.ts
 *
 * Decode a failed transaction by orchestrating the OFFICIAL packages first, so
 * the doctor never falls behind upstream:
 *
 *   - @solana/errors            getSolanaErrorFromTransactionError /
 *                               getSolanaErrorFromInstructionError / isSolanaError
 *                               decode the raw RPC TransactionError + InstructionError
 *                               shapes into typed, human-readable SolanaError objects.
 *   - @solana-developers/helpers decodeAnchorTransaction auto-fetches each program's
 *                               IDL by program id and decodes the instructions.
 *
 * For program-specific Custom codes (>= 6000) you still resolve against the IDL
 * (see decode-reference.md Path 3); @solana/errors covers the runtime/framework
 * variants, not your program's own error enum.
 *
 * Run:
 *   npm i @solana/web3.js @solana/errors @solana-developers/helpers
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx decode-with-official-primitives.ts <SIGNATURE>
 */

import { Connection } from "@solana/web3.js";
import {
  getSolanaErrorFromTransactionError,
  getSolanaErrorFromInstructionError,
  isSolanaError,
} from "@solana/errors";
import { decodeAnchorTransaction } from "@solana-developers/helpers";

/**
 * Decode meta.err using @solana/errors. If it is a per-instruction failure,
 * also decode the inner detail with the instruction index for a richer message.
 */
function decodeTransactionError(metaErr: unknown): {
  message: string;
  instructionIndex: number | null;
  instructionMessage: string | null;
} {
  // getSolanaErrorFromTransactionError accepts a string or a single-key object.
  const txError = getSolanaErrorFromTransactionError(
    metaErr as string | { [key: string]: unknown }
  );

  let instructionIndex: number | null = null;
  let instructionMessage: string | null = null;

  // Pull out { InstructionError: [index, detail] } if present and decode the detail.
  if (
    metaErr &&
    typeof metaErr === "object" &&
    Array.isArray((metaErr as any).InstructionError)
  ) {
    const [index, detail] = (metaErr as any).InstructionError as [number, unknown];
    instructionIndex = index;
    const ixError = getSolanaErrorFromInstructionError(
      index,
      detail as string | { [key: string]: unknown }
    );
    instructionMessage = isSolanaError(ixError) ? ixError.message : String(ixError);
  }

  return {
    message: isSolanaError(txError) ? txError.message : String(txError),
    instructionIndex,
    instructionMessage,
  };
}

async function main() {
  const signature = process.argv[2];
  if (!signature) {
    console.error("Usage: npx tsx decode-with-official-primitives.ts <SIGNATURE>");
    process.exit(1);
  }
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (tx === null) {
    console.log("Transaction not on chain (dropped or wrong cluster). See diagnose-signature.ts.");
    return;
  }
  if (tx.meta?.err == null) {
    console.log("Transaction SUCCEEDED. Nothing to decode.");
    return;
  }

  // 1) Decode the error shapes with the official package.
  const decoded = decodeTransactionError(tx.meta.err);
  console.log("ERROR (via @solana/errors)");
  console.log(`  transaction-level: ${decoded.message}`);
  if (decoded.instructionIndex !== null) {
    console.log(`  instruction #${decoded.instructionIndex}: ${decoded.instructionMessage}`);
  }

  // 2) Decode what the transaction tried to do, IDLs auto-fetched by program id.
  try {
    const anchorDecoded = await decodeAnchorTransaction(connection, signature);
    console.log("\nDECODED INSTRUCTIONS (via @solana-developers/helpers)");
    console.log(anchorDecoded.toString());
  } catch (e) {
    console.log("\n(decodeAnchorTransaction could not decode: no fetchable IDL for a program)");
    console.log(`  ${e instanceof Error ? e.message : String(e)}`);
  }

  // 3) Reminder: program Custom codes >= 6000 are resolved against the IDL errors array.
  if (
    tx.meta.err &&
    typeof tx.meta.err === "object" &&
    Array.isArray((tx.meta.err as any).InstructionError)
  ) {
    const detail = (tx.meta.err as any).InstructionError[1];
    if (detail && typeof detail === "object" && "Custom" in detail && detail.Custom >= 6000) {
      console.log(
        `\nNOTE: Custom(${detail.Custom}) is a program-specific code. Resolve it against the failing program's IDL errors array (see decode-reference.md Path 3) and resources/dex-error-codes.md for DEX codes.`
      );
    }
  }
}

main().catch((e) => {
  console.error("decode-with-official-primitives failed:", e);
  process.exit(1);
});
