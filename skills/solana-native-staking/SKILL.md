---
name: solana-native-staking
description: Create and manage native Solana stake accounts end to end with the StakeProgram from @solana/web3.js. Use when staking SOL directly to a validator (not via an LST), or when working with stake accounts, delegate to a validator vote account, activation warmup, deactivate, cooldown, withdraw inactive stake, split a stake account for partial unstake, merge compatible stake accounts, or change the stake or withdraw authority. Keywords: native staking, stake account, delegate, validator, vote account, deactivate, withdraw, split, merge, authorize, warmup, cooldown, activation, StakeProgram, rent-exempt reserve, minimum delegation. This is the native staking path that LST skills (sanctum, marinade) do not cover.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Native Staking

Build and operate native Solana stake accounts directly against the on-chain Stake program (`Stake11111111111111111111111111111111111111`) using the `StakeProgram` helpers in `@solana/web3.js`. This is native delegation to a validator vote account, not a liquid staking token. There is no LST mint, no pool, and no protocol fee: the user owns a stake account whose lamports are delegated to a validator and earn inflation rewards each epoch.

## Overview

Native staking is the base-layer way to stake SOL. LST skills (`sanctum`, `marinade`, and pool-based staking) wrap this flow behind a liquid token and a pool; this skill covers the raw account lifecycle they sit on top of. Reach for it when the user wants to delegate to a specific validator they choose, keep custody of the stake account itself, avoid LST/pool fees, or manage operations that only exist at the native layer: split, merge, and re-authorizing the stake or withdraw authority.

A stake account is a normal on-chain account owned by the Stake program. It holds two pieces of state:

- **Meta**: the rent-exempt reserve, the `authorized` pair (a **stake authority** that can delegate/deactivate/split/merge, and a **withdraw authority** that can withdraw and change authorities), and a `lockup`.
- **Stake / delegation**: the delegated `voter` (validator vote account), the delegated `stake` lamports, the `activationEpoch`, the `deactivationEpoch`, and a warmup/cooldown rate.

The lifecycle is epoch-driven and the source of almost every "why is my stake not active/withdrawable yet" question:

1. **Create** a stake account funded with the rent-exempt reserve plus the lamports to stake.
2. **Delegate** it to a validator's vote account. The stake is **activating** and becomes fully **active** after a one-epoch warmup.
3. **Deactivate** when you want to unstake. The stake is **deactivating** and becomes **inactive** after a one-epoch cooldown.
4. **Withdraw** lamports once the stake is inactive (or withdraw the excess above the delegated amount at any time).
5. **Split / merge** for partial unstake (split off a portion into a new account, then deactivate just that) and consolidation (merge compatible accounts to reduce account count).

The single biggest correctness trap: `Connection.getStakeActivation` is **deprecated** in `@solana/web3.js` and the underlying `getStakeActivation` RPC method was dropped by validators (deprecated since RPC v1.18), so it fails at runtime against modern RPC nodes even though the method still type-checks. Do not rely on it. Derive activation status from the stake account's delegation fields and the current epoch instead. See Step 6 and `resources/stake-lifecycle.md`.

## Instructions

Run the steps for the operation the user wants. Each step states its success criterion. Always confirm the cluster (devnet for testing, mainnet for real funds) and which keypair holds the stake authority vs the withdraw authority before signing anything.

### Step 1: Establish authorities and amounts

Decide the two authorities up front; they default to the funding wallet but can differ:

- **Stake authority**: delegates, deactivates, splits, merges. Operational, can be hot.
- **Withdraw authority**: withdraws lamports and changes either authority. This is the account that controls the money; treat it as cold.

Compute the funding amount as **rent-exempt reserve + lamports to delegate**:

```ts
const rentExempt = await connection.getMinimumBalanceForRentExemption(
  StakeProgram.space // the stake account data size
);
const lamports = rentExempt + amountToStakeLamports;
```

The delegated portion must meet the network **minimum delegation**. Fetch it at runtime with `connection.getStakeMinimumDelegation()` (present in `@solana/web3.js` v1, confirmed through v1.98.4; it returns `RpcResponseAndContext<number>`, so read `res.value` in lamports) rather than hardcoding, since it is a network parameter (currently 1 SOL on mainnet). On a much older `@solana/web3.js` that predates the method, fall back to the 1 SOL floor and surface that you assumed it.

**Success criterion:** You have a stake-authority pubkey, a withdraw-authority pubkey, the funded lamports (reserve + stake), and a delegated amount at or above the minimum delegation.

### Step 2: Create the stake account

Generate a fresh keypair for the stake account (or derive a seed-based address) and fund it in one transaction:

```ts
const stakeAccount = Keypair.generate();
const createTx = StakeProgram.createAccount({
  fromPubkey: payer.publicKey,
  stakePubkey: stakeAccount.publicKey,
  authorized: new Authorized(stakeAuthority, withdrawAuthority),
  lockup: new Lockup(0, 0, PublicKey.default), // no lockup
  lamports, // rent reserve + stake
});
```

Sign with **both** the payer and the new stake account keypair (the new account must sign its own creation). `Lockup(0, 0, PublicKey.default)` means no lockup; a non-default custodian or non-zero `unixTimestamp`/`epoch` locks withdrawals until that condition passes.

**Success criterion:** The stake account exists on chain, is owned by the Stake program, holds `lamports`, and is **initialized but undelegated** (no `voter` yet).

### Step 3: Choose a validator vote account

Delegation targets a validator's **vote account**, not its identity or its node pubkey. Pull live validators and pick by commission, recent performance, and decentralization (avoid the top stake-weighted validators to spread the network):

```ts
const { current } = await connection.getVoteAccounts();
// each entry: votePubkey, nodePubkey, commission, activatedStake, lastVote, epochCredits
```

**Success criterion:** You have a valid `votePubkey` for an active, voting validator with acceptable commission.

### Step 4: Delegate

Delegate the created account to the chosen vote account, signed by the **stake authority**:

```ts
const delegateTx = StakeProgram.delegate({
  stakePubkey: stakeAccount.publicKey,
  authorizedPubkey: stakeAuthority,
  votePubkey: voteAccount,
});
```

After this lands, the stake is **activating**. It does not earn rewards or count as active until the **next** epoch boundary completes the one-epoch warmup. Redelegating to a different validator requires deactivate then re-delegate (or the dedicated redelegate flow if your tooling supports it); do not expect a direct validator switch without a cooldown.

**Success criterion:** The stake account's delegation now has `voter = votePubkey` and `activationEpoch = current epoch`; status is `activating`.

### Step 5: Deactivate (begin unstake)

When unstaking, deactivate first, signed by the **stake authority**:

```ts
const deactivateTx = StakeProgram.deactivate({
  stakePubkey: stakeAccount.publicKey,
  authorizedPubkey: stakeAuthority,
});
```

The stake is now **deactivating** and becomes **inactive** after a one-epoch cooldown. You cannot withdraw the delegated lamports until it is inactive. Deactivation does not move funds; it only schedules the stake to stop being delegated.

**Success criterion:** The delegation's `deactivationEpoch` is set to the current epoch; status is `deactivating`.

### Step 6: Read activation status without getStakeActivation

`connection.getStakeActivation` is deprecated and the RPC method it calls has been dropped by validators, so it errors at runtime against current nodes. Derive status from the parsed stake account plus the current epoch instead:

```ts
const epochInfo = await connection.getEpochInfo();
const currentEpoch = epochInfo.epoch;
const parsed = await connection.getParsedAccountInfo(stakeAccount.publicKey);
// parsed.value.data.parsed.info.stake.delegation has:
//   voter, stake, activationEpoch, deactivationEpoch (bigint-as-string)
```

Apply this logic (full table in `resources/stake-lifecycle.md`):

- No `delegation` (or `voter` absent): **inactive / undelegated**.
- `activationEpoch === currentEpoch` and not yet deactivated: **activating** (warming up this epoch).
- `activationEpoch < currentEpoch` and `deactivationEpoch` is the max-u64 sentinel: **active**.
- `deactivationEpoch === currentEpoch`: **deactivating** (cooling down this epoch).
- `deactivationEpoch < currentEpoch`: **inactive** (cooldown complete, withdrawable).

The sentinel for "not deactivated" is `u64::MAX` (`18446744073709551615`). Treat that value as "no deactivation scheduled." If you need exact warming/cooling lamport amounts mid-epoch (partial warmup), that precision came from `getStakeActivation`; without it, report status at epoch granularity and tell the user the precise active lamports settle at the epoch boundary. Flag this limitation rather than reporting a false exact number.

**Success criterion:** You report one of {undelegated, activating, active, deactivating, inactive} derived only from on-chain delegation fields and the current epoch.

### Step 7: Withdraw

Once the stake is **inactive** (or to pull excess lamports above the delegated stake at any time), withdraw with the **withdraw authority**:

```ts
const withdrawTx = StakeProgram.withdraw({
  stakePubkey: stakeAccount.publicKey,
  authorizedPubkey: withdrawAuthority,
  toPubkey: destination,
  lamports: amountToWithdraw,
});
```

Withdrawing the **entire** balance (including the rent reserve) closes the account. To keep the account alive, leave at least the rent-exempt reserve. Withdrawing delegated lamports before the stake is inactive fails; only the non-delegated excess (e.g. accumulated rewards above the delegation, or the reserve) is withdrawable while active.

**Success criterion:** Lamports moved to `toPubkey`; if drained fully, the stake account no longer exists.

### Step 8 (optional): Split for partial unstake

To unstake only part of the position without deactivating the whole account, split off a portion into a new stake account (signed by the **stake authority**), then deactivate and withdraw just that piece:

```ts
const splitStake = Keypair.generate();
const splitTx = StakeProgram.split(
  {
    stakePubkey: stakeAccount.publicKey,
    authorizedPubkey: stakeAuthority,
    splitStakePubkey: splitStake.publicKey,
    lamports: amountToSplit, // delegated lamports to move into the new account
  },
  rentExempt // the new split account needs its own rent-exempt reserve
);
```

The new account inherits the same authorities, lockup, and delegation/activation state. Both the source and the destination must still satisfy the minimum delegation after the split. The `splitStakePubkey` keypair must sign. In `@solana/web3.js` v1 (confirmed through v1.98.4), `split` takes the rent-exempt reserve as the second argument: `StakeProgram.split(params, rentExemptReserve)`.

**Success criterion:** Two stake accounts exist, each delegated to the same validator with the same state, each at or above minimum delegation.

### Step 9 (optional): Merge compatible accounts

Consolidate two stake accounts into one to reduce account count and management overhead, signed by the **stake authority**. Merge has strict compatibility rules:

```ts
const mergeTx = StakeProgram.merge({
  stakePubkey: destinationStake, // absorbs the source
  sourceStakePubKey: sourceStake, // drained and closed
  authorizedPubkey: stakeAuthority,
});
```

Both accounts must have identical authorities and lockups, and compatible activation states (see `resources/stake-lifecycle.md` for the exact compatible-state matrix: e.g. two fully active stakes delegated to the **same** vote account, or two inactive stakes, or specific activating combinations within the same epoch). After merge the source is closed and its lamports move into the destination.

**Success criterion:** The destination holds the combined stake, the source no longer exists, and the merge did not violate a compatibility rule.

### Step 10 (optional): Change an authority

Re-point the stake or withdraw authority (for example, hand the withdraw authority to a cold wallet), signed by the **current** corresponding authority:

```ts
const authTx = StakeProgram.authorize({
  stakePubkey: stakeAccount.publicKey,
  authorizedPubkey: currentAuthority, // current holder must sign
  newAuthorizedPubkey: newAuthority,
  stakeAuthorizationType: StakeAuthorizationLayout.Withdrawer, // or .Staker
});
```

Changing the **withdrawer** must be signed by the current withdrawer; changing the **staker** can be signed by either the staker or the withdrawer. A lockup with a custodian restricts changing the withdrawer until the lockup passes (or the custodian co-signs).

**Success criterion:** The targeted authority is updated on chain and the previous holder no longer controls that capability.

## Examples

### Example 1: Stake 2 SOL to a validator (create + delegate)

User asks: "Stake 2 SOL to validator vote account `Vote111...`."

The agent runs `examples/create-delegate.ts`:

1. Computes `rentExempt = getMinimumBalanceForRentExemption(StakeProgram.space)` and confirms `2 SOL >= minimum delegation`.
2. Generates a stake account keypair, builds `StakeProgram.createAccount` with `Authorized(payer, payer)` and `Lockup(0,0,default)`, funded with `rentExempt + 2 SOL`.
3. Builds `StakeProgram.delegate` to the vote account.
4. Sends one transaction containing both instructions, signed by payer + stake account keypair.
5. Reports: account address, delegated amount, and that the stake is **activating** and becomes **active** after the next epoch warmup. Does not claim it is active immediately.

### Example 2: Unstake and withdraw (deactivate, wait, withdraw)

User asks: "Unstake my stake account `Stake9...` and send the SOL back to my wallet."

The agent runs `examples/deactivate-withdraw.ts`:

1. Reads the parsed account and current epoch; confirms it is **active**.
2. Builds and sends `StakeProgram.deactivate` (stake authority). Reports status now **deactivating**, withdrawable after the one-epoch cooldown.
3. Re-checks status by deriving it from delegation fields vs current epoch (no `getStakeActivation`). Loops at the epoch boundary, not in a tight poll, until **inactive**.
4. Once inactive, builds `StakeProgram.withdraw` for the full balance to the destination (closing the account) and sends it with the withdraw authority.
5. Reports the destination balance change and that the stake account is now closed.

### Example 3: Partial unstake via split

User asks: "Unstake 1 SOL out of my 5 SOL stake, leave the rest staked."

The agent: computes a fresh rent-exempt reserve for the new account, runs `StakeProgram.split` to move 1 SOL of delegation into a new stake account (verifying both sides stay at/above minimum delegation), then runs the deactivate then withdraw flow on the new 1 SOL account only. The original 4 SOL account stays active and delegated, undisturbed.

## Guidelines

- **DO** confirm the cluster and the holder of each authority before signing; use devnet for any test.
- **DO** fund a new stake account with rent-exempt reserve **plus** the stake, and keep the delegated amount at or above the network minimum delegation.
- **DO** fetch the minimum delegation at runtime (`getStakeMinimumDelegation` where available) rather than hardcoding 1 SOL.
- **DO** derive activation status from delegation fields + current epoch; `getStakeActivation` is deprecated and its RPC method no longer works against current nodes.
- **DO** treat warmup and cooldown as one full epoch each; tell the user activation/withdrawability happens at the **next epoch boundary**, not immediately.
- **DO** sign create with both payer and the new stake account keypair, and split with the new split account keypair.
- **DO** use the **stake** authority for delegate/deactivate/split/merge and the **withdraw** authority for withdraw/authorize-withdrawer.
- **DON'T** call `connection.getStakeActivation`; it is deprecated and the RPC method behind it has been dropped, so it fails against current nodes.
- **DON'T** try to withdraw delegated lamports before the stake is inactive; only excess above the delegation is withdrawable while active.
- **DON'T** merge incompatible stakes (different authorities, lockups, or incompatible activation states); it will fail.
- **DON'T** split below the minimum delegation on either side.
- **DON'T** confuse the validator vote account with its identity/node pubkey; delegate to the **vote** account.
- **DON'T** expect instant validator switching; redelegation goes through a cooldown.

## Common Errors

| Symptom | Cause | Solution |
|---------|-------|----------|
| `getStakeActivation` RPC error / "method not found" at runtime | Method is deprecated in `@solana/web3.js` and the underlying RPC was dropped by validators. | Derive status from delegation fields + current epoch (Step 6); do not call `getStakeActivation`. |
| Withdraw fails / "insufficient funds" while stake looks staked | Stake still active or only mid-cooldown; delegated lamports are locked until inactive. | Deactivate first, wait the full one-epoch cooldown, confirm **inactive**, then withdraw. |
| Delegate succeeds but rewards/active stake do not show | Warmup not finished; stake is **activating** this epoch. | Wait for the next epoch boundary; status flips to **active** then. |
| `Custom` error on createAccount | Funded below rent-exempt reserve, or delegated portion below minimum delegation. | Fund `rentExempt + stake`; ensure delegated amount >= minimum delegation. |
| Merge fails | Mismatched authorities/lockups or incompatible activation states. | Match authorities and lockups; only merge compatible states (see `resources/stake-lifecycle.md`). |
| Split fails or leaves an unusable account | One side dropped below minimum delegation, or missing rent reserve on the new account. | Keep both sides at/above minimum; fund the new account's rent-exempt reserve. |
| Authorize-withdrawer rejected | Signed by the staker instead of the current withdrawer (or a lockup/custodian blocks it). | Sign with the current withdraw authority; satisfy or co-sign the lockup. |
| Account unexpectedly closed after withdraw | Withdrew the full balance including the rent reserve. | Leave at least the rent-exempt reserve to keep the account alive. |

## References

- `resources/stake-lifecycle.md` - the five states, epoch warmup/cooldown timing, the status-from-fields derivation (replacing `getStakeActivation`), the `u64::MAX` deactivation sentinel, split rules, and the merge compatibility matrix.
- `examples/create-delegate.ts` - create a stake account (rent reserve + stake) and delegate to a vote account in one transaction; prints status. Runnable with `@solana/web3.js`.
- `examples/deactivate-withdraw.ts` - deactivate, derive status without `getStakeActivation`, wait for inactive, then withdraw and close. Runnable with `@solana/web3.js`.
- Solana staking concepts: https://solana.com/docs/references/staking
- Stake program (agave): https://github.com/anza-xyz/agave/tree/master/programs/stake
- `@solana/web3.js` `StakeProgram`: https://solana-labs.github.io/solana-web3.js/classes/StakeProgram.html
- `getStakeMinimumDelegation` RPC: https://solana.com/docs/rpc/http/getstakeminimumdelegation
