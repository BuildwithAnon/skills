/**
 * cpi-stack-trace.ts
 *
 * Reconstruct the CPI call stack of a failed transaction and attribute the
 * failure to the exact inner program, then print an indented tree plus a verdict.
 *
 * It does three things:
 *   1. Parses the "Program <id> invoke [depth]" / "success" / "failed" log pairs
 *      to find the deepest frame open at the first failure (the program that
 *      actually reverted).
 *   2. Aligns that to meta.innerInstructions from getTransaction so the on-chain
 *      structure confirms the log reading.
 *   3. Resolves account roles through Address Lookup Tables (for v0 transactions)
 *      so every account index maps to a real pubkey.
 *
 * Run:
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx cpi-stack-trace.ts <SIGNATURE>
 */

import {
  Connection,
  PublicKey,
  AddressLookupTableAccount,
  MessageAccountKeys,
} from "@solana/web3.js";

interface Frame {
  programId: string;
  depth: number;
  failed: boolean;
  failReason?: string;
}

/**
 * Walk the logs, maintaining an invoke stack. Return the ordered list of frames
 * (in first-seen order) and the deepest frame that was open at the first failure.
 */
function parseCpiStack(logs: string[]): {
  frames: Frame[];
  revertedFrame: Frame | null;
} {
  const frames: Frame[] = [];
  const stack: Frame[] = [];
  let revertedFrame: Frame | null = null;

  for (const line of logs) {
    const invoke = line.match(/Program (\S+) invoke \[(\d+)\]/);
    if (invoke) {
      const frame: Frame = {
        programId: invoke[1],
        depth: Number(invoke[2]),
        failed: false,
      };
      stack.push(frame);
      frames.push(frame);
      continue;
    }
    if (/Program \S+ success/.test(line)) {
      stack.pop();
      continue;
    }
    const failed = line.match(/Program (\S+) failed: (.+)$/);
    if (failed) {
      // First failure is the innermost program that reverted.
      const top = stack.length ? stack[stack.length - 1] : null;
      if (top && top.programId === failed[1]) {
        top.failed = true;
        top.failReason = failed[2];
        revertedFrame = revertedFrame ?? top;
      } else if (!revertedFrame) {
        const frame: Frame = {
          programId: failed[1],
          depth: stack.length ? stack[stack.length - 1].depth : 1,
          failed: true,
          failReason: failed[2],
        };
        revertedFrame = frame;
      }
      stack.pop();
    }
  }
  return { frames, revertedFrame };
}

/** Resolve the full index-to-pubkey mapping, including ALT-loaded keys (v0). */
async function resolveAccountKeys(
  connection: Connection,
  message: {
    addressTableLookups?: { accountKey: PublicKey }[];
    getAccountKeys: (args?: {
      addressLookupTableAccounts?: AddressLookupTableAccount[] | null;
    }) => MessageAccountKeys;
  }
): Promise<MessageAccountKeys> {
  const lookups = message.addressTableLookups ?? [];
  if (lookups.length === 0) {
    return message.getAccountKeys();
  }
  const tables = await Promise.all(
    lookups.map((l) => connection.getAddressLookupTable(l.accountKey))
  );
  const accounts = tables
    .map((t) => t.value)
    .filter((v): v is AddressLookupTableAccount => v !== null);
  return message.getAccountKeys({ addressLookupTableAccounts: accounts });
}

async function main() {
  const signature = process.argv[2];
  if (!signature) {
    console.error("Usage: npx tsx cpi-stack-trace.ts <SIGNATURE>");
    process.exit(1);
  }
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (tx === null) {
    console.log("Transaction not on chain (dropped or wrong cluster).");
    return;
  }

  const logs = tx.meta?.logMessages ?? [];
  const { frames, revertedFrame } = parseCpiStack(logs);

  // Resolve account keys (handles v0 ALTs).
  const keys = await resolveAccountKeys(connection, tx.transaction.message as any);

  // Top-level instruction index from the error, if any.
  let topLevelIndex: number | null = null;
  const err = tx.meta?.err as any;
  if (err && typeof err === "object" && Array.isArray(err.InstructionError)) {
    topLevelIndex = err.InstructionError[0];
  }

  // Print the indented tree from the frames.
  console.log("CPI STACK");
  for (const f of frames) {
    const indent = "  ".repeat(Math.max(0, f.depth - 1));
    const mark = f.failed ? `  FAILED: ${f.failReason}` : "";
    console.log(`${indent}Program ${f.programId} invoke [${f.depth}]${mark}`);
  }

  // Align to innerInstructions: under the failing top-level index, list the
  // inner programs that ran, resolved to pubkeys via the account keys.
  if (topLevelIndex !== null && tx.meta?.innerInstructions) {
    const inner = tx.meta.innerInstructions.find((g) => g.index === topLevelIndex);
    if (inner) {
      console.log(`\nINNER INSTRUCTIONS under top-level ix #${topLevelIndex}`);
      inner.instructions.forEach((ix, i) => {
        const prog = keys.get(ix.programIdIndex)?.toBase58() ?? `idx ${ix.programIdIndex}`;
        const accts = ix.accounts
          .map((a) => keys.get(a)?.toBase58() ?? `idx ${a}`)
          .slice(0, 4)
          .join(", ");
        console.log(`  [${i}] program ${prog}  accounts: ${accts}${ix.accounts.length > 4 ? ", ..." : ""}`);
      });
    }
  }

  // Verdict.
  console.log("\nVERDICT");
  if (revertedFrame) {
    console.log(
      `  failing program = ${revertedFrame.programId} at depth ${revertedFrame.depth}` +
        (topLevelIndex !== null ? `, under top-level instruction #${topLevelIndex}` : "") +
        `\n  reason: ${revertedFrame.failReason ?? "see logs"}`
    );
  } else {
    console.log("  no failing frame found in logs (transaction may have succeeded or logs are missing).");
  }
}

main().catch((e) => {
  console.error("cpi-stack-trace failed:", e);
  process.exit(1);
});
