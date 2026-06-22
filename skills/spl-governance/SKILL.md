---
name: spl-governance
description: Participate in SPL Governance / Realms DAOs on Solana as a token holder. Use when an agent must read a Realm, deposit governing tokens to gain vote weight, create a proposal, add executable instructions, sign off to open voting, cast a vote, or execute a passed proposal. Keywords: SPL Governance, Realms, DAO, proposal, vote, governance token, TokenOwnerRecord, community mint, council mint, voter weight, @solana/spl-governance. Distinct from squads (squads is a token-less multisig wallet; this is token-weighted DAO governance).
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# SPL Governance (Realms DAOs)

A procedure for an agent to act inside an SPL Governance DAO (the program behind Realms): read a Realm and its proposals, deposit governing tokens to obtain vote weight, create and sign off a proposal, cast a vote, and execute a passed proposal once its hold-up period clears.

## Overview

SPL Governance is the on-chain program that powers Realms DAOs on Solana. A DAO is a `Realm`. Members gain influence by depositing a governing token (the realm's **community** mint or its **council** mint) into the program, which records their weight in a `TokenOwnerRecord`. A `Governance` account holds the rules (thresholds, voting time, hold-up period) for the treasury or program it controls. To change something on chain, a member creates a `Proposal` under a `Governance`, attaches the instructions to run (`ProposalTransaction`), signs off to open voting, members `withCastVote` Yes/No, and after the proposal succeeds and a hold-up period passes, anyone executes the attached instructions.

The TypeScript SDK is **`@solana/spl-governance`**. Its instruction builders are `with*` functions (`withDepositGoverningTokens`, `withCreateProposal`, `withInsertTransaction`, `withSignOffProposal`, `withCastVote`, `withExecuteTransaction`). Each one **pushes a `TransactionInstruction` into an array you pass in**; it does not send anything. You collect those instructions, build a transaction, sign, and send yourself. Several builders return a value (for example the new proposal address, or a PDA) while still mutating the array.

> SDK note: these are all real exports of `@solana/spl-governance`, verified against 0.3.28. Two argument types catch people in this line: `withDepositGoverningTokens` takes a bn.js `BN` amount (not a bigint), and `withCreateProposal` takes a numeric `proposalIndex` (= the governance's `proposalCount`), not a seed pubkey. Argument order can shift across majors, so pin the version and check the generated typings if a call does not type-check. The account model and lifecycle below are stable.

Use this skill when the user wants to take part in a token-based DAO: inspect a realm, become a voting member, draft or vote on a proposal, or execute one that passed. Do **not** use it for Squads multisigs (those are signer-set wallets with no governing token and no `Realm`); use the `squads` skill for that.

## Instructions

Run the steps in order. Reading (Steps 1 and 2) is always safe. Any step that deposits tokens, creates a proposal, votes, or executes sends a transaction and should be confirmed with the user first.

### Step 1: Resolve the realm and its governance program id

A realm is owned by a governance **program instance**. The canonical SPL Governance program id is `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`, but **multiple instances of the program are deployed**, and DAOs commonly run on their own instance. Never hardcode the program id for an arbitrary realm.

- Fetch the realm account: read the owner of the realm's account on chain (`connection.getAccountInfo(realmPubkey).owner`) to learn which governance program controls it, or use the SDK's `getRealm(connection, realmPubkey)` reader and take the program id from the returned account's `owner`.
- Use **that** program id for every subsequent `with*` call and every PDA derivation. A wrong program id silently derives wrong PDAs and the instructions will fail.

**Success criterion:** You have the `Realm` account data and the exact governance program id that owns it, and you will reuse that id for all later calls.

### Step 2: Read the realm's structure (governances, proposals, mints)

Before acting, map what exists. See `resources/accounts-and-flow.md` for the full account model.

- Read the realm's **community mint** and (if set) **council mint** from the realm account. These are two separate governing-token tracks; a proposal and a vote each target one mint, not both.
- List the `Governance` accounts under the realm with `getGovernanceAccounts(connection, programId, Governance, [pubkeyFilter(1, realmPubkey)])` (the `Governance` account class and `pubkeyFilter` are both exports; the realm pubkey sits at offset 1, after the 1-byte account-type tag). There is no `getGovernanceAccountsByRealm` in `@solana/spl-governance` 0.3.x. Each `Governance` is the rule-set for one treasury, token account, mint, or program.
- List proposals with `getAllProposals(connection, programId, realmPubkey)` (returns one inner array per governance) or per-governance with `getProposalsByGovernance(connection, programId, governancePubkey)`. Read each proposal's `state` to know whether it is Draft, Voting, Succeeded, Defeated, or Executing/Completed.

**Success criterion:** You can name the governances under the realm, the governing mints, and the current state of the proposals you care about, without sending any transaction.

### Step 3: Check or establish vote weight (TokenOwnerRecord)

A member's vote weight lives in a `TokenOwnerRecord` PDA, keyed by `(realm, governing mint, owner)`.

- Read the caller's record with `getTokenOwnerRecordForRealm(...)`, or derive the PDA with `getTokenOwnerRecordAddress(...)` and `getAccountInfo`. Its `governingTokenDepositAmount` is the deposited balance that backs plain token-weighted voting.
- If the caller has no record or insufficient weight and wants to vote/propose, deposit governing tokens with `withDepositGoverningTokens`. This builder pushes instructions that move tokens from the caller's associated token account into the realm and create/grow the `TokenOwnerRecord`. Choose the **community** or **council** mint deliberately, since they are independent tracks.
- **Voter-weight plugins / addins caveat (read this):** many realms enable a voter-weight addin (for example **VSR**, vote-escrowed/locked tokens, or NFT-based weight). When an addin is active, the plain `TokenOwnerRecord.governingTokenDepositAmount` is **not** the vote weight the program uses; weight is computed by the addin and supplied through a `VoterWeightRecord`. Detect this from the realm config: in `@solana/spl-governance` 0.3.x the realm account carries boolean flags `realm.account.config.useCommunityVoterWeightAddin` / `useMaxCommunityVoterWeightAddin`. The addin's actual program id lives in the separate `RealmConfigAccount` (read it with `getRealmConfig` / derive with `getRealmConfigAddress`), under `communityTokenConfig.voterWeightAddin` / `maxVoterWeightAddin`. When a flag is set, you must produce the addin's `VoterWeightRecord` (via that addin's own SDK) and pass it to vote/create-proposal calls. Check this before assuming a deposit alone grants weight, and tell the user when an addin is in play.

**Success criterion:** You know the caller's effective vote weight and how it is computed (plain deposit vs addin), and have either confirmed sufficient weight or built the deposit (and, if needed, addin) instructions.

### Step 4: Create a proposal and attach its instructions

To change something on chain, draft a proposal under the relevant `Governance`.

- Build the proposal with `withCreateProposal`. You pass the realm, the governance, the proposer's `TokenOwnerRecord`, the governing mint, a name and description (the description is usually a URL or short string, not the full payload), and the vote type. The builder pushes the create instruction and returns the new proposal address. Most DAO actions vote on the **community** mint unless the action is council-gated.
- Attach each executable instruction with `withInsertTransaction`. This wraps the real on-chain instruction(s) you want the DAO to run (for example a treasury transfer signed by the governance's PDA) into a `ProposalTransaction` at an index/option you choose. Add one per instruction (or batch) the proposal should perform. A purely signaling proposal can have zero attached transactions.
- Designate a signatory with `withAddSignatory` if the flow requires sign-off by someone other than the proposer; often the proposer signs off themselves.

**Success criterion:** You have the proposal address and an instruction array that creates the proposal and inserts every transaction it should execute, ready to send.

### Step 5: Sign off to open voting

A freshly created proposal is in **Draft** and is not yet votable.

- Push `withSignOffProposal` from the proposal owner or designated signatory. This transitions the proposal from Draft to **Voting** and starts the voting clock defined by the `Governance` config.
- Send the transaction (it can include Steps 4 and 5 together if size allows, or be split). Confirm the proposal `state` is now Voting.

**Success criterion:** The proposal is in the Voting state and the voting window is open.

### Step 6: Cast a vote

Members with vote weight vote during the voting window.

- Push `withCastVote` with the realm, governance, proposal, the voter's `TokenOwnerRecord`, the governing mint, and the vote choice (Yes/Approve or No/Deny). This creates the voter's `VoteRecord` and applies their weight.
- If a voter-weight addin is active (Step 3), pass the addin's `VoterWeightRecord` to this call; otherwise the program uses the `TokenOwnerRecord` deposit weight.
- A voter can withdraw/relinquish a vote with `withRelinquishVote` while voting is open if they change their mind.

**Success criterion:** The voter's `VoteRecord` exists and their weight is reflected in the proposal's Yes/No tallies.

### Step 7: Execute a passed proposal after the hold-up period

After voting ends and the proposal reaches **Succeeded**, the attached transactions can be run, but not instantly.

- Wait for the `Governance` config's **hold-up period** (a cooldown after success before execution is allowed) to elapse. Read it from the governance config; do not attempt execution before it passes or the call fails.
- Push `withExecuteTransaction` once per attached `ProposalTransaction`, passing the instruction's accounts. Execution is **permissionless**: anyone can trigger it once eligible, not only the proposer. Each successful execution runs the wrapped instruction with the governance PDA as signer.

**Success criterion:** Every attached `ProposalTransaction` is executed, the on-chain effect (treasury transfer, config change, etc.) has occurred, and the proposal reaches Completed.

## Examples

### Example 1: Read a realm and list its proposals (read-only)

User input: "What proposals does this DAO have and which are still open to vote? Realm `<REALM_PUBKEY>`."

The agent runs `examples/read-realm-and-proposals.ts`:

1. **Resolve program id (Step 1):** read `getAccountInfo(realm).owner` to get the governance program that owns this realm rather than assuming `GovER5...`.
2. **Read structure (Step 2):** load the realm, print its community mint and council mint, list the governances under it, then list proposals per governance.
3. **Report:** for each proposal, print name, governing mint, and `state` (Draft / Voting / Succeeded / Defeated / Completed), flagging which are currently in Voting. No transaction is sent.

This is the safe default first move: never propose or vote before reading the realm and confirming the program id.

### Example 2: Deposit, create a proposal, sign off, and vote

User input: "Join this DAO with my tokens, open a proposal to send 10 USDC from the treasury, and vote yes."

The agent runs `examples/create-proposal-and-vote.ts`, which demonstrates the `with*` accumulate-then-send pattern:

1. **Program id + weight (Steps 1, 3):** resolve the realm's program id, read the caller's `TokenOwnerRecord`; if weight is missing, push `withDepositGoverningTokens` for the chosen (community) mint into the instruction array. Detect any voter-weight addin first and flag it.
2. **Create + attach (Step 4):** push `withCreateProposal` (capturing the returned proposal address), then `withInsertTransaction` wrapping the treasury transfer instruction the DAO should run.
3. **Sign off (Step 5):** push `withSignOffProposal` to move Draft to Voting.
4. **Vote (Step 6):** push `withCastVote` with a Yes choice.
5. **Send:** assemble the accumulated instructions into one or more transactions (split if over size), sign, send. Execution (Step 7) is left until after voting succeeds and the hold-up period clears.

## Guidelines

- **DO** read the realm's owning program id from chain and reuse it everywhere. **DON'T** hardcode `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`; many realms run on their own program instance.
- **DO** treat the community mint and council mint as two separate governing-token tracks. A proposal, a `TokenOwnerRecord`, and a vote each target exactly one mint.
- **DO** detect voter-weight addins (VSR / vote-escrow, NFT weight) from the realm config before assuming a token deposit equals vote weight. **DON'T** rely on `TokenOwnerRecord.governingTokenDepositAmount` when an addin computes weight; supply the addin's `VoterWeightRecord`.
- **DO** remember the `with*` builders only push instructions into an array; you must collect, build, sign, and send the transaction yourself.
- **DO** sign off a proposal (Step 5) to open voting. A proposal left in Draft is never votable.
- **DO** wait out the governance hold-up period before `withExecuteTransaction`; execution is permissionless once eligible.
- **DON'T** confuse this with Squads. Squads is a multisig signer set with vaults and no governing token; SPL Governance is token-weighted with a `Realm`, `Governance`, and `TokenOwnerRecord`.
- **DON'T** invent export names. If a `with*` builder or reader does not type-check against the installed `@solana/spl-governance`, check its typings for the current spelling and argument order, or derive the PDA and read the account directly.

## Common Errors

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| PDAs resolve to empty / instructions fail with wrong owner | Used `GovER5...` for a realm that runs on a different governance program instance. | Read the realm account's `owner` and use that program id for all PDAs and `with*` calls. |
| Vote has no effect / weight is zero despite a deposit | A voter-weight addin (e.g. VSR) is active; plain deposit weight is ignored. | Produce the addin's `VoterWeightRecord` via its SDK and pass it to `withCastVote` / `withCreateProposal`. |
| Proposal cannot be voted on | Proposal is still in Draft; never signed off. | Push `withSignOffProposal` (proposer or signatory) to open voting. |
| `withExecuteTransaction` fails right after the vote passes | Governance hold-up / cooldown period has not elapsed. | Read the governance config's hold-up period and wait until it passes, then execute. |
| Deposit succeeds but proposal/vote still rejected for the mint | Mixed up community vs council mint between deposit, record, proposal, and vote. | Use the same governing mint consistently for the deposit, `TokenOwnerRecord`, proposal, and vote. |
| Import of a `with*` / reader fails at build time | SDK version exports a different name or signature than expected. | Check the installed `@solana/spl-governance` typings / README and use the exact exported name and argument order. |

### Error: Wrong governance program assumed
**Cause:** Hardcoding the canonical program id for a realm deployed on its own instance.
**Solution:** Always read `getAccountInfo(realmPubkey).owner` (or the realm reader's account `owner`) and use that program id everywhere.

### Error: Deposited tokens but still no vote weight
**Cause:** A voter-weight addin computes weight and overrides the raw deposit amount.
**Solution:** Check the realm config flags `useCommunityVoterWeightAddin` / `useMaxCommunityVoterWeightAddin` (the addin program id itself is in the separate `RealmConfigAccount`, via `getRealmConfig`); if set, build and pass the addin's `VoterWeightRecord`.

## References

- `resources/accounts-and-flow.md` - the account model (Realm, Governance, Proposal, TokenOwnerRecord, VoteRecord, ProposalTransaction, SignatoryRecord, VoterWeightRecord), the full proposal lifecycle, the community-vs-council mint distinction, and the voter-weight addin caveat in detail.
- `examples/read-realm-and-proposals.ts` - resolve the realm's program id from chain, read the realm, list governances and proposals with their states. Read-only.
- `examples/create-proposal-and-vote.ts` - the `with*` accumulate-then-send flow: deposit governing tokens, create a proposal, insert an executable instruction, sign off, and cast a vote.
- `@solana/spl-governance` on npm: https://www.npmjs.com/package/@solana/spl-governance (pin the current version here).
- SPL Governance program source: https://github.com/solana-labs/solana-program-library/tree/master/governance
- Realms app: https://app.realms.today
- Governance docs / Realms docs: https://docs.realms.today
