/**
 * read-realm-and-proposals.ts
 *
 * Read-only inspection of an SPL Governance (Realms) DAO:
 *   1. Resolve the realm's OWNING governance program id from chain
 *      (do NOT hardcode GovER5..., many realms run on their own instance).
 *   2. Read the realm (community mint, optional council mint).
 *   3. List the governances under the realm.
 *   4. List proposals per governance and print each one's state.
 *
 * Sends no transaction. Safe to run against mainnet.
 *
 * Run:
 *   npm i @solana/web3.js @solana/spl-governance
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx read-realm-and-proposals.ts <REALM_PUBKEY>
 *
 * VERSION NOTE: verified against @solana/spl-governance 0.3.28. getRealm,
 * getAllProposals, getGovernanceAccounts, pubkeyFilter, the Governance account
 * class, and the ProposalState enum are all real exports. Governances are listed
 * with getGovernanceAccounts(conn, programId, Governance, [pubkeyFilter(1, realm)])
 * (there is no getGovernanceAccountsByRealm in this line). The Governance
 * account stores its realm at offset 1 (1-byte account-type discriminator first).
 */

import { Connection, PublicKey } from "@solana/web3.js";
import {
  getRealm,
  getAllProposals,
  getGovernanceAccounts,
  pubkeyFilter,
  Governance,
  ProposalState,
} from "@solana/spl-governance";

// Canonical SPL Governance program id. Used ONLY as a fallback / sanity note.
// The real program id for a realm is read from the realm account's owner below.
const CANONICAL_GOVERNANCE_PROGRAM_ID = new PublicKey(
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw"
);

async function main() {
  const realmArg = process.argv[2];
  if (!realmArg) {
    console.error("Usage: npx tsx read-realm-and-proposals.ts <REALM_PUBKEY>");
    process.exit(1);
  }
  const realmPubkey = new PublicKey(realmArg);
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  // -------------------------------------------------------------------------
  // Step 1: resolve the OWNING governance program id from chain.
  // The owner of the realm account IS the governance program instance.
  // -------------------------------------------------------------------------
  const realmInfo = await connection.getAccountInfo(realmPubkey);
  if (!realmInfo) {
    console.error("Realm account not found. Check the pubkey and the cluster.");
    process.exit(1);
  }
  const programId = realmInfo.owner;
  console.log("Realm:               ", realmPubkey.toBase58());
  console.log("Governance program:  ", programId.toBase58());
  if (!programId.equals(CANONICAL_GOVERNANCE_PROGRAM_ID)) {
    console.log(
      "  (note) this realm runs on a NON-canonical governance instance: " +
        "all PDAs/instructions must use the program id above, not GovER5..."
    );
  }

  // -------------------------------------------------------------------------
  // Step 2: read the realm (community mint + optional council mint).
  // -------------------------------------------------------------------------
  const realm = await getRealm(connection, realmPubkey);
  const communityMint: PublicKey = realm.account.communityMint;
  // councilMint lives on the realm config.
  const councilMint: PublicKey | undefined =
    realm.account.config?.councilMint ?? undefined;

  console.log("\nGoverning mints:");
  console.log("  community mint:    ", communityMint.toBase58());
  console.log(
    "  council mint:      ",
    councilMint ? councilMint.toBase58() : "(none)"
  );
  console.log(
    "  (community and council are SEPARATE vote tracks: proposals/votes target one)"
  );

  // Voter-weight addin caveat: if the realm config flags a community
  // voter-weight addin (e.g. VSR), a plain token deposit is NOT the vote
  // weight. The flag lives on the realm config as `useCommunityVoterWeightAddin`;
  // the addin's actual program id lives in the separate RealmConfigAccount
  // (read via getRealmConfig / getRealmConfigAddress) and its SDK supplies the
  // VoterWeightRecord.
  const communityAddin = realm.account.config?.useCommunityVoterWeightAddin;
  if (communityAddin) {
    console.log(
      "\n  WARNING: this realm uses a voter-weight addin (e.g. VSR). " +
        "Plain TokenOwnerRecord deposit weight will be overridden; voting/" +
        "proposing needs a VoterWeightRecord from the addin's SDK."
    );
  }

  // -------------------------------------------------------------------------
  // Step 3: list governances under the realm.
  // -------------------------------------------------------------------------
  // Filter Governance accounts by their `realm` field (offset 1: a 1-byte
  // account-type discriminator precedes it). pubkeyFilter returns undefined for
  // a null key, so coerce to the MemcmpFilter[] getGovernanceAccounts expects.
  const realmFilter = pubkeyFilter(1, realmPubkey)!;
  const governances = await getGovernanceAccounts(
    connection,
    programId,
    Governance,
    [realmFilter]
  );
  console.log(`\nGovernances under realm: ${governances.length}`);

  // -------------------------------------------------------------------------
  // Step 4: list proposals and print state. getAllProposals returns a nested
  // array (one inner array per governance), so flatten it.
  // -------------------------------------------------------------------------
  const nested: any[][] = await getAllProposals(
    connection,
    programId,
    realmPubkey
  );
  const proposals: any[] = nested.flat();

  console.log(`\nProposals: ${proposals.length}`);
  for (const p of proposals) {
    // ProposalState is an enum; p.account.state is the numeric value.
    const stateName = describeState(p.account?.state);
    const name = p.account?.name ?? "(unnamed)";
    const mint = p.account?.governingTokenMint?.toBase58?.() ?? "?";
    const track = mint === communityMint.toBase58() ? "community" : "council/other";
    console.log(
      `  - ${name}\n      pubkey: ${p.pubkey.toBase58()}\n      state:  ${stateName}\n      track:  ${track} (mint ${mint})`
    );
  }

  const open = proposals.filter(
    (p) => describeState(p.account?.state) === "Voting"
  );
  console.log(
    `\nOpen to vote now (Voting state): ${open.length}` +
      (open.length
        ? "\n  " + open.map((p) => p.pubkey.toBase58()).join("\n  ")
        : "")
  );
}

/** Map the numeric proposal state to its ProposalState name. */
function describeState(state: unknown): string {
  if (typeof state === "number") {
    const name = ProposalState[state];
    if (name) return name;
  }
  return `state(${String(state)})`;
}

main().catch((e) => {
  console.error("read-realm-and-proposals failed:", e);
  process.exit(1);
});
