/**
 * simulate-before-sign.ts
 *
 * Vet an UNSIGNED VersionedTransaction before signing or sending it.
 *
 * Simulates with sigVerify:false (tx is not signed yet) and
 * replaceRecentBlockhash:true (ignore a stale/missing blockhash for the dry
 * run), then reports unitsConsumed, programs touched, SOL balance deltas, and
 * a go/no-go verdict. On a simulated failure it decodes the reason the same way
 * the post-mortem path does, BEFORE a single lamport is spent.
 *
 * Run:
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx simulate-before-sign.ts <BASE64_VERSIONED_TX>
 *
 * The argument is a base64-serialized VersionedTransaction (unsigned or with
 * placeholder signatures). In real use you would pass the tx object directly
 * from your build step rather than serialize/deserialize.
 */

import {
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

interface SimReport {
  go: boolean;
  unitsConsumed: number | null;
  recommendedComputeUnitLimit: number | null;
  programsTouched: string[];
  writableAccounts: string[];
  solDeltas: { account: string; deltaSol: number }[];
  failure?: { name: string; message: string; logsTail: string[] };
}

/** Programs touched, from the invoke log lines, in first-seen order. */
function programsTouched(logs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of logs) {
    const m = line.match(/Program (\S+) invoke \[\d+\]/);
    if (m && !seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** Anchor decoded line or hex code, for the no-go reason. */
function decodeFailure(logs: string[]): { name: string; message: string } {
  for (const line of logs) {
    const m = line.match(
      /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/
    );
    if (m) return { name: `${m[1]} (${m[2]})`, message: m[3] };
  }
  for (const line of logs) {
    const m = line.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (m) {
      const code = parseInt(m[1], 16);
      return {
        name: `Custom(${code})`,
        message: `Program returned custom error ${code}. Resolve via IDL/registry (see decode-reference.md).`,
      };
    }
  }
  return {
    name: "SimulationError",
    message: "Simulation failed; see logs tail for the program failure line.",
  };
}

async function simulate(
  connection: Connection,
  tx: VersionedTransaction
): Promise<SimReport> {
  const writableAccounts = collectWritableAccounts(tx);

  const sim = await connection.simulateTransaction(tx, {
    sigVerify: false, // not signed yet
    replaceRecentBlockhash: true, // dry-run, ignore stale/missing blockhash
    accounts: {
      encoding: "base64",
      addresses: writableAccounts,
    },
  });

  const value = sim.value;
  const logs = value.logs ?? [];
  const touched = programsTouched(logs);

  // SOL deltas for the writable accounts we requested post-state for.
  const solDeltas: { account: string; deltaSol: number }[] = [];
  if (value.accounts) {
    for (let i = 0; i < value.accounts.length; i++) {
      const post = value.accounts[i];
      if (!post) continue;
      // Pre-balance must come from the caller's own bookkeeping or a getMultipleAccounts
      // read; simulateTransaction returns post-state only. Here we surface post lamports.
      solDeltas.push({
        account: writableAccounts[i],
        deltaSol: post.lamports / LAMPORTS_PER_SOL, // post-state balance in SOL
      });
    }
  }

  if (value.err !== null) {
    const f = decodeFailure(logs);
    return {
      go: false,
      unitsConsumed: value.unitsConsumed ?? null,
      recommendedComputeUnitLimit: null,
      programsTouched: touched,
      writableAccounts,
      solDeltas,
      failure: { ...f, logsTail: logs.slice(-6) },
    };
  }

  const units = value.unitsConsumed ?? null;
  return {
    go: true,
    unitsConsumed: units,
    recommendedComputeUnitLimit: units != null ? Math.ceil(units * 1.15) : null,
    programsTouched: touched,
    writableAccounts,
    solDeltas,
  };
}

/** Resolve writable account keys from a v0 message (static keys only here). */
function collectWritableAccounts(tx: VersionedTransaction): string[] {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const out: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (msg.isAccountWritable(i)) out.push(keys[i]);
  }
  return out;
}

async function main() {
  const b64 = process.argv[2];
  if (!b64) {
    console.error("Usage: npx tsx simulate-before-sign.ts <BASE64_VERSIONED_TX>");
    process.exit(1);
  }
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
  const report = await simulate(connection, tx);

  console.log(report.go ? "VERDICT: GO" : "VERDICT: NO-GO");
  console.log(`  unitsConsumed:        ${report.unitsConsumed ?? "n/a"}`);
  if (report.recommendedComputeUnitLimit != null)
    console.log(
      `  set CU limit to:      ${report.recommendedComputeUnitLimit} (unitsConsumed * 1.15)`
    );
  console.log(`  programs touched:     ${report.programsTouched.join(", ") || "none"}`);
  console.log(`  writable accounts:    ${report.writableAccounts.length}`);
  for (const d of report.solDeltas) {
    console.log(`    ${d.account}: post-balance ${d.deltaSol} SOL`);
  }
  if (report.failure) {
    console.log(`  failure:              ${report.failure.name}`);
    console.log(`  reason:               ${report.failure.message}`);
    console.log("  logs tail:");
    for (const l of report.failure.logsTail) console.log(`    ${l}`);
  }

  if (!report.go) process.exit(2); // non-zero so callers gate on it
}

main().catch((e) => {
  console.error("simulate-before-sign failed:", e);
  process.exit(1);
});
