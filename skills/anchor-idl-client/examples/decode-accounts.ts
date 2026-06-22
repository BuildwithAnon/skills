/**
 * decode-accounts.ts
 *
 * Read and decode an Anchor program's accounts using only its IDL.
 *
 * Flow: fetch the IDL on chain (fallback to a bundled copy) -> construct a
 * typed Program -> list/decode accounts of a given type with an optional
 * memcmp filter. Also shows decoding a single base64 account blob (no fetch).
 *
 * Targets @coral-xyz/anchor 0.30.x: new Program(idl, provider) reads the
 * program id from idl.address. On pre-0.30 the constructor is
 * new Program(idl, programId, provider) instead (see note in main()).
 *
 * Run:
 *   npm i @coral-xyz/anchor @solana/web3.js
 *   ANCHOR_PROVIDER_URL=https://api.mainnet-beta.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *     npx tsx decode-accounts.ts <PROGRAM_ID> <ACCOUNT_NAME> [FILTER_PUBKEY]
 *
 * ACCOUNT_NAME is the IDL account type name (PascalCase, e.g. "Vault").
 * If FILTER_PUBKEY is given, accounts are filtered by their first field
 * (offset 8) equal to that pubkey.
 *
 * Optional: provide a local IDL when the program did not publish one on chain:
 *   IDL_PATH=./my_program.json npx tsx decode-accounts.ts <PROGRAM_ID> <ACCOUNT_NAME>
 */

import { Program, AnchorProvider, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

/** Lowercase the first character: IDL PascalCase name -> client accessor key. */
function toAccessorKey(name: string): string {
  return name.length ? name[0].toLowerCase() + name.slice(1) : name;
}

async function main() {
  const programIdArg = process.argv[2];
  const accountName = process.argv[3]; // PascalCase IDL type name, e.g. "Vault"
  const filterPubkey = process.argv[4]; // optional, matched at offset 8

  if (!programIdArg || !accountName) {
    console.error(
      "Usage: npx tsx decode-accounts.ts <PROGRAM_ID> <ACCOUNT_NAME> [FILTER_PUBKEY]"
    );
    process.exit(1);
  }

  const programId = new PublicKey(programIdArg);

  // Provider: AnchorProvider.env() reads ANCHOR_PROVIDER_URL / ANCHOR_WALLET.
  // For pure read/decode you do not need a funded wallet, only a connection.
  let provider: AnchorProvider;
  try {
    provider = AnchorProvider.env();
  } catch {
    // No env wallet configured: build a connection-only provider for reads.
    const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
    const connection = new Connection(rpc, "confirmed");
    // A dummy read-only wallet is fine; we never sign here.
    provider = new AnchorProvider(connection, {} as any, {});
  }

  // --- Step 2: obtain the IDL ---
  let idl: Idl | null = null;
  if (process.env.IDL_PATH) {
    idl = JSON.parse(readFileSync(process.env.IDL_PATH, "utf8")) as Idl;
  } else {
    // On-chain fetch. Returns null if the program never published its IDL.
    idl = await Program.fetchIdl(programId, provider);
  }
  if (!idl) {
    console.error(
      `No IDL: Program.fetchIdl returned null and no IDL_PATH was provided.\n` +
        `The program ${programId.toBase58()} did not publish an IDL on chain.\n` +
        `Provide a bundled copy via IDL_PATH=./program.json and re-run.`
    );
    process.exit(2);
  }

  // --- Step 3: construct the typed client ---
  // Anchor 0.30.x: program id comes from idl.address.
  // Pre-0.30 would be: new Program(idl, programId, provider)
  const program = new Program(idl, provider);
  console.log(`program: ${program.programId.toBase58()}`);

  const accessor = toAccessorKey(accountName); // "Vault" -> "vault"
  const namespace = (program.account as any)[accessor];
  if (!namespace) {
    console.error(
      `Account type "${accountName}" not found in IDL. Available: ${Object.keys(
        program.account as any
      ).join(", ")}`
    );
    process.exit(2);
  }

  // --- Step 4: read and decode ---
  // memcmp offsets are measured against raw bytes, which start with the
  // 8-byte discriminator, so the first field is at offset 8.
  const filters = filterPubkey
    ? [{ memcmp: { offset: 8, bytes: new PublicKey(filterPubkey).toBase58() } }]
    : [];

  const accounts = await namespace.all(filters);
  console.log(`found ${accounts.length} ${accountName} account(s):`);
  for (const a of accounts) {
    console.log(`\n  pubkey: ${a.publicKey.toBase58()}`);
    console.log(`  data:   ${stringify(a.account)}`);
  }

  // --- Bonus: decode a single base64 account blob with no RPC fetch ---
  // const buf = Buffer.from(someBase64, "base64"); // full data incl. discriminator
  // const decoded = program.coder.accounts.decode(accountName, buf);
  // console.log(decoded);
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
  console.error("decode-accounts failed:", e);
  process.exit(1);
});
