/**
 * resolve-and-reverse.ts
 *
 * Two SNS lookups, forward and reverse:
 *   1. Forward: resolve a .sol name to the address that should RECEIVE funds,
 *      using resolve() so SOL records and NFT tokenization are honored
 *      (NOT the raw registry owner, which can be a different wallet).
 *   2. Reverse: turn a domain account public key back into its .sol name.
 *
 * Also prints the low-level registry owner for contrast, so you can see when
 * resolve() and registry.owner diverge (a published SOL record or a tokenized
 * NFT). When they differ, resolve() is the correct payment target.
 *
 * Package: @bonfida/spl-name-service (v3), peer dep @solana/web3.js v1.
 * Pass names WITHOUT the .sol suffix.
 *
 * Run:
 *   npm i @bonfida/spl-name-service @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx resolve-and-reverse.ts <NAME_WITHOUT_DOT_SOL>
 *
 * Example:
 *   npx tsx resolve-and-reverse.ts bonfida
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  resolve,
  getDomainKeySync,
  NameRegistryState,
  reverseLookup,
} from "@bonfida/spl-name-service";

/** Strip a trailing ".sol" if the caller passed one; the SDK wants the bare label. */
function normalize(name: string): string {
  return name.endsWith(".sol") ? name.slice(0, -".sol".length) : name;
}

async function forwardResolve(connection: Connection, name: string) {
  // The correct funds-recipient address. resolve() walks the SNS-IP-5 order:
  // NFT holder -> SOL record V2 -> SOL record V1 -> registry owner.
  const recipient: PublicKey = await resolve(connection, name);

  // For contrast only: the low-level registry owner. Do NOT route payments to
  // this; it ignores SOL records. We print it to show when it diverges.
  const { pubkey } = getDomainKeySync(name);
  const { registry, nftOwner } = await NameRegistryState.retrieve(
    connection,
    pubkey
  );

  return {
    domainAccount: pubkey.toBase58(),
    fundsRecipient: recipient.toBase58(), // <- use THIS to send funds
    registryOwner: registry.owner.toBase58(), // admin control, not payout
    nftOwner: nftOwner ? nftOwner.toBase58() : null,
  };
}

async function reverseFromName(connection: Connection, name: string) {
  // Derive the domain account, then reverse it back to a name as a round-trip
  // sanity check (in real use you would already hold a domain account key,
  // e.g. one returned by getAllDomains).
  const { pubkey } = getDomainKeySync(name);
  const resolvedName = await reverseLookup(connection, pubkey);
  return { domainAccount: pubkey.toBase58(), name: resolvedName };
}

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error("Usage: npx tsx resolve-and-reverse.ts <NAME_WITHOUT_DOT_SOL>");
    process.exit(1);
  }
  const name = normalize(raw);
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  const fwd = await forwardResolve(connection, name);
  const rev = await reverseFromName(connection, name);

  console.log(`FORWARD RESOLVE  ${name}.sol`);
  console.log(`  domain account:   ${fwd.domainAccount}`);
  console.log(`  funds recipient:  ${fwd.fundsRecipient}   <- send funds here`);
  console.log(`  registry owner:   ${fwd.registryOwner}   (admin control)`);
  console.log(`  nft owner:        ${fwd.nftOwner ?? "none (not tokenized)"}`);

  if (fwd.fundsRecipient !== fwd.registryOwner) {
    console.log(
      "  NOTE: recipient != registry owner. A SOL record or NFT redirects" +
        " payments. resolve() is correct; registry.owner would be wrong."
    );
  }

  console.log(`REVERSE LOOKUP`);
  console.log(`  ${rev.domainAccount} -> ${rev.name}.sol`);
}

main().catch((e) => {
  console.error("resolve-and-reverse failed:", e);
  process.exit(1);
});
