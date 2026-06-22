/**
 * parse-events.ts
 *
 * Parse Anchor events out of a transaction's logs using only the program's IDL.
 *
 * Flow: build a BorshCoder from the IDL -> build an EventParser for the program
 * id -> fetch the transaction -> feed meta.logMessages into parser.parseLogs ->
 * print each typed { name, data } event.
 *
 * Anchor `emit!` events are written to the log as base64 "Program data:" lines;
 * EventParser decodes them. CPI events (`emit_cpi!`) are NOT in the logs and
 * are not handled here (see note at the bottom).
 *
 * Targets @coral-xyz/anchor 0.30.x.
 *
 * Run:
 *   npm i @coral-xyz/anchor @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *   IDL_PATH=./my_program.json \
 *     npx tsx parse-events.ts <PROGRAM_ID> <SIGNATURE>
 *
 * If IDL_PATH is omitted, the IDL is fetched on chain with Program.fetchIdl.
 */

import {
  Program,
  AnchorProvider,
  BorshCoder,
  EventParser,
  type Idl,
} from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

async function main() {
  const programIdArg = process.argv[2];
  const signature = process.argv[3];

  if (!programIdArg || !signature) {
    console.error("Usage: npx tsx parse-events.ts <PROGRAM_ID> <SIGNATURE>");
    process.exit(1);
  }

  const programId = new PublicKey(programIdArg);
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  // --- obtain the IDL (local file, else on-chain fetch) ---
  let idl: Idl | null = null;
  if (process.env.IDL_PATH) {
    idl = JSON.parse(readFileSync(process.env.IDL_PATH, "utf8")) as Idl;
  } else {
    // fetchIdl needs a provider; a connection-only provider is enough to read.
    const provider = new AnchorProvider(connection, {} as any, {});
    idl = await Program.fetchIdl(programId, provider);
  }
  if (!idl) {
    console.error(
      `No IDL: provide IDL_PATH=./program.json, or the program did not publish ` +
        `an IDL on chain (Program.fetchIdl returned null).`
    );
    process.exit(2);
  }

  // --- Step 5: build the coder + event parser ---
  const coder = new BorshCoder(idl);
  const parser = new EventParser(programId, coder);

  // --- fetch the transaction (maxSupportedTransactionVersion required for v0) ---
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    console.error(
      `Transaction ${signature} not found (or pass the right cluster). ` +
        `Note: omitting maxSupportedTransactionVersion makes v0 txs return null.`
    );
    process.exit(2);
  }

  const logs = tx.meta?.logMessages ?? [];
  if (logs.length === 0) {
    console.error("No log messages on this transaction.");
    process.exit(2);
  }

  // --- parse: parseLogs is a generator of { name, data } ---
  let count = 0;
  for (const event of parser.parseLogs(logs)) {
    count++;
    console.log(`\nevent: ${event.name}`);
    console.log(`data:  ${stringify(event.data)}`);
  }

  if (count === 0) {
    console.log(
      "No Anchor events found in logs.\n" +
        "Checklist: (1) is the program id correct? (2) does the IDL match the " +
        "deployed program? (3) does the program use emit_cpi! (CPI events are " +
        "in inner-instruction data, not logs, and need coder.events.decode)."
    );
  } else {
    console.log(`\nparsed ${count} event(s).`);
  }
}

/** JSON with BN / PublicKey rendered readably. */
function stringify(obj: unknown): string {
  return JSON.stringify(
    obj,
    (_k, v) => {
      if (v && typeof v === "object" && typeof (v as any).toBase58 === "function") {
        return (v as any).toBase58(); // PublicKey
      }
      if (v && typeof v === "object" && (v as any).constructor?.name === "BN") {
        return (v as any).toString(); // BN -> decimal string
      }
      return v;
    },
    2
  );
}

main().catch((e) => {
  console.error("parse-events failed:", e);
  process.exit(1);
});
