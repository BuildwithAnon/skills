# SPL Governance: Account Model, Proposal Lifecycle, and the Voter-Weight Caveat

The reference for the account types an agent reads and writes, the order a proposal moves through, and the two facts that most often trip an agent up: the community-vs-council mint split and voter-weight addins.

> The export names below (account readers, PDA helpers, `with*` builders) are real exports of `@solana/spl-governance`. The on-chain account model and the lifecycle are stable across versions; argument order can shift across major versions, so check the installed typings if a call does not type-check.

## The governance program is not a single deployment

There is a canonical SPL Governance program id, `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw`, but the program is reusable and **many instances are deployed**. A given `Realm` is owned by one specific instance, and DAOs frequently run on their own. The owning program id is the account owner of the realm account.

**Rule:** read `connection.getAccountInfo(realmPubkey).owner` to learn the governance program id for a realm, and use that id for every PDA derivation and every `with*` instruction. Hardcoding `GovER5...` for an arbitrary realm derives the wrong PDAs and the instructions fail with an owner mismatch.

## Account types

| Account | What it is | Keyed by (PDA seeds, roughly) |
|---------|------------|-------------------------------|
| **Realm** | The DAO itself. Holds config: the community mint, optional council mint, and any voter-weight / max-voter-weight addins. | realm name + community mint |
| **Governance** | The rule-set for one thing the DAO controls (a treasury account, a token account, a mint, or an upgradeable program). Holds vote thresholds, voting time, and the **hold-up period**. | realm + the governed account |
| **TokenOwnerRecord** | A member's deposited governing tokens and base vote weight for one realm + one governing mint + one owner. Created/grown by depositing. | realm + governing mint + owner |
| **Proposal** | A single proposal under a `Governance`. Carries its `state`, vote options, and tallies. | governance + governing mint + proposal index/seed |
| **ProposalTransaction** | One executable instruction (or batch) attached to a proposal, run on execution. A proposal can have several, across vote options. | proposal + option index + transaction index |
| **SignatoryRecord** | A required signer who must sign off before voting opens. | proposal + signatory |
| **VoteRecord** | One member's cast vote on one proposal (choice + applied weight). Prevents double voting. | proposal + voter's TokenOwnerRecord |
| **VoterWeightRecord** | (Addin only) The vote weight computed by a voter-weight addin for a member, supplied to vote/propose calls when an addin is active. Owned by the addin program, not core governance. | defined by the addin |

### Reading accounts

The common reader functions:

- `getRealm(connection, realmPubkey)` - the realm account and config.
- `getGovernanceAccountsByRealm(connection, programId, realmPubkey)` - the governances under a realm.
- `getProposalsByGovernance(connection, programId, governancePubkey)` or `getAllProposals(connection, programId, realmPubkey)` - proposals.
- `getTokenOwnerRecordForRealm(...)` / `getTokenOwnerRecordsByOwner(...)` - a member's deposit/weight record(s).
- `getVoteRecord(...)` - a cast vote.

If a reader does not type-check, derive the PDA with the SDK's `get*Address` helper and `connection.getAccountInfo`, then deserialize. Always pass the **realm's owning program id** from the step above.

## Community mint vs council mint

A realm has up to two independent governing-token tracks:

- **Community mint** - the broad token-holder vote. Most DAO actions vote here.
- **Council mint** - an optional smaller, often permissioned set (a board/core team). Some actions are council-gated.

These are **separate end to end**. A `TokenOwnerRecord` is per mint, a `Proposal` is created against one governing mint, and a `VoteRecord` applies the weight from the matching mint's record. **Pick one mint and use it consistently** across deposit, record, proposal creation, and vote. Mixing them is a common cause of "deposited but my vote does nothing for this proposal".

## Voter-weight addins (the caveat that matters most)

By default, a member's vote weight is the `governingTokenDepositAmount` on their `TokenOwnerRecord`: deposit more tokens, get more weight. **But many realms enable a voter-weight addin**, and then that assumption is wrong.

A voter-weight addin is a separate program the realm config points to (`communityVoterWeightAddin`, and optionally `maxVoterWeightAddin`). Examples:

- **VSR (Voter Stake Registry)** - vote-escrow / lockup weighting: longer-locked tokens get more weight than the raw deposited amount.
- **NFT voter** - weight derived from holding NFTs in a collection, not from a fungible deposit.
- Other custom plugins.

When an addin is active:

1. The core program does **not** read `TokenOwnerRecord.governingTokenDepositAmount` as the vote weight.
2. Weight is computed by the addin and written to a **`VoterWeightRecord`** (and a `MaxVoterWeightRecord` for quorum math), which you must produce via the **addin's own SDK**.
3. You must pass that `VoterWeightRecord` to `withCastVote` and `withCreateProposal`.

**Always check the realm config for a voter-weight addin before assuming a plain token deposit grants vote weight.** If one is present, building the addin's records is a prerequisite to voting/proposing, and the agent should tell the user that this realm uses a plugin (e.g. VSR) so a simple deposit alone will not give them weight.

## Proposal lifecycle

```
                deposit governing tokens
                (withDepositGoverningTokens)
                          |
                          v
           +---- TokenOwnerRecord (vote weight) ----+
           |                                        |
           v                                        v
   withCreateProposal                         withCastVote (later)
           |
           v
       [ Draft ]  proposal exists, NOT votable yet
           |
   withInsertTransaction (attach 0..n executable instructions)
           |
   withAddSignatory (optional, if someone else must sign off)
           |
   withSignOffProposal   <-- proposer or signatory opens voting
           |
           v
      [ Voting ]  voting window open (length set by Governance config)
           |
   members withCastVote (Yes/No); optional withRelinquishVote while open
           |
           v
   voting ends -> [ Succeeded ] or [ Defeated ]
           |
        (Succeeded)
           |
   ***** HOLD-UP / COOLDOWN PERIOD must elapse *****
           |
           v
   withExecuteTransaction  <-- permissionless; anyone can run each attached tx
           |
           v
     [ Completed ]  on-chain effects applied
```

### Lifecycle notes

- **Draft is not votable.** A proposal must be signed off (`withSignOffProposal`) to enter Voting. This is the single most common "why can't anyone vote" cause.
- **Voting length** comes from the `Governance` config, not the proposal.
- **Hold-up period** is a cooldown after Succeeded and before execution is allowed, also from the `Governance` config. Calling `withExecuteTransaction` before it elapses fails. Read the config and wait.
- **Execution is permissionless.** Once a proposal Succeeded and the hold-up passed, anyone (not just the proposer) may execute each attached `ProposalTransaction`. Each runs its wrapped instruction with the governance PDA as the signer.
- **Signaling proposals** (no on-chain effect) simply attach zero `ProposalTransaction`s; they still go through Draft -> sign off -> Voting -> Succeeded/Defeated.

## The `with*` builder pattern

Every mutating SDK helper is a `with*` function that **pushes a `TransactionInstruction` into an array you pass in** and does not send anything. Typical shape:

```ts
const instructions: TransactionInstruction[] = [];

// builder mutates `instructions` and may return a useful value (e.g. a PDA)
const proposalAddress = await withCreateProposal(
  instructions,        // accumulator the builder pushes into
  programId,           // the realm's OWNING program id (Step 1)
  programVersion,      // governance program version (getGovernanceProgramVersion)
  realmPubkey,
  governancePubkey,
  proposerTokenOwnerRecord,
  name,
  descriptionLink,
  governingTokenMint,  // community OR council mint, chosen deliberately
  proposerPubkey,
  /* ...vote type, options, payer, etc. */
);

// later: build, sign, send the accumulated instructions yourself
const tx = new Transaction().add(...instructions);
```

Collect all the `with*` outputs into one array (split into multiple transactions if it exceeds size limits), then sign and send. The builders never touch the network on their own.

## Quick checklist before sending anything

1. Resolved the realm's owning program id from chain (not hardcoded). 
2. Picked community vs council mint and used it consistently. 
3. Checked for a voter-weight addin; built its `VoterWeightRecord` if present. 
4. Have (or are creating) a `TokenOwnerRecord` with enough weight. 
5. For a proposal: created, inserted transactions, **and signed off** to open voting. 
6. For execution: confirmed Succeeded **and** the hold-up period elapsed. 
7. Pinned the `@solana/spl-governance` version and checked the typings if any call did not type-check.
