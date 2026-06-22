/**
 * list-domains.ts
 *
 * List every .sol domain a wallet owns (with names), and read the wallet's
 * primary domain.
 *
 *   1. getDomainKeysWithReverses(connection, owner) -> [{ pubKey, domain }]
 *      Preferred over getAllDomains + a manual reverseLookup loop because it
 *      returns the names in one pass.
 *   2. getPrimaryDomain(connection, owner) -> { domain, reverse, stale }
 *      The wallet's primary (formerly "favorite") .sol name. ALWAYS check the
 *      `stale` flag: a stale result means the wallet no longer owns that
 *      primary domain and it must not be shown as the wallet's identity.
 *
 * Package: @bonfida/spl-name-service (v3), peer dep @solana/web3.js v1.
 *
 * Run:
 *   npm i @bonfida/spl-name-service @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx list-domains.ts <WALLET_PUBKEY>
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  getDomainKeysWithReverses,
  getAllDomains,
  getPrimaryDomain,
} from "@bonfida/spl-name-service";

async function listWithNames(connection: Connection, owner: PublicKey) {
  // Preferred: names included.
  const withNames = await getDomainKeysWithReverses(connection, owner);
  return withNames.map((d) => ({
    name: `${d.domain}.sol`,
    account: d.pubKey.toBase58(),
  }));
}

async function listKeysOnly(connection: Connection, owner: PublicKey) {
  // Keys-only fallback when you do not need names (one less round trip per name).
  const keys: PublicKey[] = await getAllDomains(connection, owner);
  return keys.map((k) => k.toBase58());
}

async function readPrimary(connection: Connection, owner: PublicKey) {
  const primary = await getPrimaryDomain(connection, owner);
  // primary: { domain: PublicKey, reverse: string, stale: boolean }
  return {
    name: primary.reverse ? `${primary.reverse}.sol` : null,
    account: primary.domain ? primary.domain.toBase58() : null,
    stale: primary.stale,
  };
}

async function main() {
  const walletArg = process.argv[2];
  if (!walletArg) {
    console.error("Usage: npx tsx list-domains.ts <WALLET_PUBKEY>");
    process.exit(1);
  }
  const owner = new PublicKey(walletArg);
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const domains = await listWithNames(connection, owner);
  const primary = await readPrimary(connection, owner);

  console.log(`DOMAINS OWNED BY ${owner.toBase58()}`);
  if (domains.length === 0) {
    console.log("  (none)");
  } else {
    for (const d of domains) console.log(`  ${d.name}   ${d.account}`);
  }
  console.log(`  total: ${domains.length}`);

  console.log("PRIMARY DOMAIN");
  if (!primary.name) {
    console.log("  (no primary domain set)");
  } else if (primary.stale) {
    console.log(
      `  ${primary.name} is STALE (wallet no longer owns it). Do NOT show as` +
        " identity; fall back to the truncated address."
    );
  } else {
    console.log(`  ${primary.name}   ${primary.account}   (valid)`);
  }

  // listKeysOnly is provided for completeness; uncomment to use it.
  // console.log(await listKeysOnly(connection, owner));
  void listKeysOnly;
}

main().catch((e) => {
  console.error("list-domains failed:", e);
  process.exit(1);
});
