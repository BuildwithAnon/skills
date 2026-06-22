/**
 * create-proposal-and-vote.ts
 *
 * Demonstrates the @solana/spl-governance `with*` instruction-builder pattern
 * end to end for a token holder acting in a Realms DAO:
 *
 *   1. Resolve the realm's OWNING governance program id from chain.
 *   2. (Optional) Deposit governing tokens to get/grow a TokenOwnerRecord
 *      and vote weight  -> withDepositGoverningTokens
 *   3. Create a proposal under a Governance               -> withCreateProposal
 *   4. Attach an executable instruction (e.g. treasury xfer) -> withInsertTransaction
 *   5. Sign off to open voting                            -> withSignOffProposal
 *   6. Cast a Yes vote                                    -> withCastVote
 *   7. (Later, after success + hold-up period)            -> withExecuteTransaction
 *
 * KEY PATTERN: every with* builder PUSHES a TransactionInstruction into an
 * array you pass in. It does NOT send. You collect the instructions, build a
 * transaction, sign, and send yourself.
 *
 * THIS SENDS TRANSACTIONS. Review and confirm with the user before running.
 *
 * Run:
 *   npm i @solana/web3.js @solana/spl-governance
 *   RPC_URL=https://api.devnet.solana.com \
 *   SECRET_KEY=[..json array..] \
 *     npx tsx create-proposal-and-vote.ts <REALM_PUBKEY> <GOVERNANCE_PUBKEY>
 *
 * VERSION NOTE: the with* builders below (withDepositGoverningTokens,
 * withCreateProposal, withInsertTransaction, withSignOffProposal, withCastVote,
 * withExecuteTransaction), the Vote/VoteKind types, getTokenOwnerRecordAddress,
 * and getGovernanceProgramVersion are all real exports of @solana/spl-governance.
 * Argument order can shift across major versions, so check the installed
 * package's typings if a call does not type-check.
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getGovernanceProgramVersion,
  getRealm,
  getTokenOwnerRecordAddress,
  getNativeTreasuryAddress,
  withDepositGoverningTokens,
  withCreateProposal,
  withInsertTransaction,
  withSignOffProposal,
  withCastVote,
  createInstructionData,
  VoteType,
  Vote,
  YesNoVote,
} from "@solana/spl-governance";

async function main() {
  const realmArg = process.argv[2];
  const govArg = process.argv[3];
  if (!realmArg || !govArg) {
    console.error(
      "Usage: npx tsx create-proposal-and-vote.ts <REALM_PUBKEY> <GOVERNANCE_PUBKEY>"
    );
    process.exit(1);
  }
  const realmPubkey = new PublicKey(realmArg);
  const governancePubkey = new PublicKey(govArg);
  const rpc = process.env.RPC_URL ?? "https://api.devnet.solana.com";
  const connection = new Connection(rpc, "confirmed");

  if (!process.env.SECRET_KEY) {
    console.error("Set SECRET_KEY to a JSON array secret key.");
    process.exit(1);
  }
  const wallet = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(process.env.SECRET_KEY))
  );

  // -------------------------------------------------------------------------
  // Step 1: resolve the OWNING governance program id from chain.
  // -------------------------------------------------------------------------
  const realmInfo = await connection.getAccountInfo(realmPubkey);
  if (!realmInfo) {
    console.error("Realm not found. Check pubkey/cluster.");
    process.exit(1);
  }
  const programId = realmInfo.owner; // the governance program instance
  console.log("Governance program:", programId.toBase58());

  // The program version drives instruction layout; read it from chain.
  const programVersion = await getGovernanceProgramVersion(connection, programId);
  console.log("Program version:", programVersion);

  // Read the realm to choose the governing mint. Most actions use the
  // community mint; council-gated actions use the council mint.
  const realm = await getRealm(connection, realmPubkey);
  const governingTokenMint: PublicKey = realm.account.communityMint;
  console.log("Governing mint (community):", governingTokenMint.toBase58());

  // Voter-weight addin check: if present, a plain deposit is NOT vote weight
  // and you must supply a VoterWeightRecord from the addin's SDK to the
  // create-proposal and cast-vote calls below.
  const addin = realm.account.config?.communityVoterWeightAddin;
  if (addin) {
    console.warn(
      "This realm uses a voter-weight addin (e.g. VSR). You must build its " +
        "VoterWeightRecord and pass it to withCreateProposal / withCastVote. " +
        "This example shows the plain-deposit path only."
    );
  }

  // The instruction accumulator that every with* builder pushes into.
  const instructions: TransactionInstruction[] = [];

  // -------------------------------------------------------------------------
  // Step 2: (optional) deposit governing tokens to get/grow vote weight.
  // withDepositGoverningTokens pushes the instruction(s) that move tokens from
  // the caller's ATA into the realm and create/grow the TokenOwnerRecord.
  // -------------------------------------------------------------------------
  const depositAmount = process.env.DEPOSIT_AMOUNT
    ? BigInt(process.env.DEPOSIT_AMOUNT)
    : 0n;
  if (depositAmount > 0n) {
    // The source token account is usually the caller's ATA for the mint.
    const sourceTokenAccount = new PublicKey(
      process.env.SOURCE_TOKEN_ACCOUNT as string
    );
    await withDepositGoverningTokens(
      instructions, // accumulator
      programId,
      programVersion,
      realmPubkey,
      sourceTokenAccount,
      governingTokenMint,
      wallet.publicKey, // governing token owner
      wallet.publicKey, // transfer authority
      wallet.publicKey, // payer
      depositAmount
    );
    console.log("Pushed deposit instructions (amount:", depositAmount, ")");
  }

  // The caller's TokenOwnerRecord PDA backs their proposing/voting rights.
  const tokenOwnerRecord: PublicKey = await getTokenOwnerRecordAddress(
    programId,
    realmPubkey,
    governingTokenMint,
    wallet.publicKey
  );
  console.log("TokenOwnerRecord:", tokenOwnerRecord.toBase58());

  // -------------------------------------------------------------------------
  // Step 3: create the proposal. withCreateProposal RETURNS the new proposal
  // address while ALSO pushing the create instruction into `instructions`.
  // This is the most argument-heavy call in the file.
  // -------------------------------------------------------------------------
  const name = "Send 10 USDC from treasury";
  const descriptionLink = "https://example.org/proposal.md"; // usually a URL
  const voteType = VoteType.SINGLE_CHOICE;
  const options = ["Approve"];
  const useDenyOption = true;

  // A fresh seed keys the proposal PDA. (Older flows used the
  // TokenOwnerRecord's proposal count as an index instead.)
  const proposalSeed = Keypair.generate().publicKey;

  const proposalAddress: PublicKey = await withCreateProposal(
    instructions, // accumulator
    programId,
    programVersion,
    realmPubkey,
    governancePubkey,
    tokenOwnerRecord,
    name,
    descriptionLink,
    governingTokenMint,
    wallet.publicKey, // governance authority (proposal owner)
    /* proposalIndexOrSeed */ proposalSeed,
    voteType,
    options,
    useDenyOption,
    wallet.publicKey // payer
    // If an addin is active, pass its VoterWeightRecord as the final arg.
  );
  console.log("Proposal address:", proposalAddress.toBase58());

  // -------------------------------------------------------------------------
  // Step 4: attach the executable instruction the DAO should run on execution.
  // Here: a SOL transfer FROM the governance's native treasury PDA. In a real
  // DAO this is whatever instruction the proposal enacts (SPL transfer, config
  // change, program upgrade, etc.), signed by the governance PDA at execution.
  // withInsertTransaction wraps your instruction into a ProposalTransaction at
  // (optionIndex, txIndex).
  // -------------------------------------------------------------------------
  // getNativeTreasuryAddress derives the PDA that signs the executed instruction.
  const treasuryPda: PublicKey = await getNativeTreasuryAddress(
    programId,
    governancePubkey
  );

  const innerIx = SystemProgram.transfer({
    fromPubkey: treasuryPda, // signed by the governance PDA at execution time
    toPubkey: wallet.publicKey, // example recipient
    lamports: 1_000_000, // 0.001 SOL example payload
  });

  await withInsertTransaction(
    instructions, // accumulator
    programId,
    programVersion,
    governancePubkey,
    proposalAddress,
    tokenOwnerRecord,
    wallet.publicKey, // governance authority
    /* optionIndex */ 0,
    /* transactionIndex */ 0,
    /* holdUpTime */ 0,
    // The instruction(s) to wrap, as InstructionData via createInstructionData.
    [createInstructionData(innerIx)],
    wallet.publicKey // payer
  );
  console.log("Pushed insert-transaction (proposal payload attached)");

  // -------------------------------------------------------------------------
  // Step 5: sign off to move Draft -> Voting. Without this, NOBODY can vote.
  // The proposer signs off using their TokenOwnerRecord when no separate
  // signatory was added.
  // -------------------------------------------------------------------------
  await withSignOffProposal(
    instructions, // accumulator
    programId,
    programVersion,
    realmPubkey,
    governancePubkey,
    proposalAddress,
    wallet.publicKey, // signatory / proposal owner
    /* signatoryRecord */ undefined,
    tokenOwnerRecord
  );
  console.log("Pushed sign-off (opens voting)");

  // -------------------------------------------------------------------------
  // Step 6: cast a Yes vote. For a single-choice proposal, build the vote with
  // Vote.fromYesNoVote(YesNoVote.Yes).
  // -------------------------------------------------------------------------
  const yesVote = Vote.fromYesNoVote(YesNoVote.Yes);

  await withCastVote(
    instructions, // accumulator
    programId,
    programVersion,
    realmPubkey,
    governancePubkey,
    proposalAddress,
    tokenOwnerRecord, // proposal owner's record
    tokenOwnerRecord, // voter's record (same wallet here)
    wallet.publicKey, // governance authority (voter)
    governingTokenMint,
    yesVote,
    wallet.publicKey // payer
    // If an addin is active, pass its VoterWeightRecord as the final arg.
  );
  console.log("Pushed cast-vote (Yes)");

  // -------------------------------------------------------------------------
  // Send the accumulated instructions. Split into multiple transactions if the
  // combined size exceeds the 1232-byte packet limit (deposit + create +
  // insert + sign-off + vote may not all fit in one tx).
  // -------------------------------------------------------------------------
  console.log(`\nAccumulated ${instructions.length} instructions. Sending...`);
  const tx = new Transaction().add(...instructions);
  const sig = await sendAndConfirmTransaction(connection, tx, [wallet]);
  console.log("Sent:", sig);

  // -------------------------------------------------------------------------
  // Step 7 (NOT run here): after the proposal SUCCEEDS and the Governance
  // hold-up period elapses, execution is PERMISSIONLESS. Anyone can run it:
  //
  //   await withExecuteTransaction(
  //     executeInstructions, programId, programVersion,
  //     governancePubkey, proposalAddress, proposalTransactionPda,
  //     [ /* the accounts the wrapped instruction needs */ ],
  //   );
  //
  // Do NOT call this before Succeeded + hold-up; it will fail.
  // -------------------------------------------------------------------------
  console.log(
    "\nProposal is now in Voting. After it Succeeds AND the governance " +
      "hold-up period passes, run withExecuteTransaction (permissionless) to " +
      "enact the attached payload."
  );
}

main().catch((e) => {
  console.error("create-proposal-and-vote failed:", e);
  process.exit(1);
});
