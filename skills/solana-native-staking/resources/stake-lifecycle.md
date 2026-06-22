# Stake Account Lifecycle

Reference for the native Solana stake account state machine: the states, the epoch-driven timing, how to read status without the deprecated `getStakeActivation`, and the rules for split and merge.

## The account, in two parts

A stake account (owned by `Stake11111111111111111111111111111111111111`) holds:

- **Meta**
  - `rentExemptReserve`: lamports that must stay to keep the account alive; not delegated, not part of stake.
  - `authorized.staker`: can `delegate`, `deactivate`, `split`, `merge`, and authorize a new staker.
  - `authorized.withdrawer`: can `withdraw` and authorize a new staker or withdrawer. Controls the money.
  - `lockup`: `{ unixTimestamp, epoch, custodian }`. Withdrawals (and changing the withdrawer) are blocked until both the timestamp and epoch have passed, unless the custodian co-signs. `Lockup(0, 0, PublicKey.default)` means no lockup.
- **Stake / delegation** (absent until first delegated)
  - `delegation.voter`: the validator vote account this stake is delegated to.
  - `delegation.stake`: delegated lamports.
  - `delegation.activationEpoch`: epoch in which `delegate` was called.
  - `delegation.deactivationEpoch`: epoch in which `deactivate` was called; `u64::MAX` (`18446744073709551615`) when not deactivated.
  - warmup/cooldown rate: how fast stake can warm up or cool down network-wide per epoch.

## States and transitions

| State | Meaning | How you get here |
|-------|---------|------------------|
| **undelegated / initialized** | Account exists, funded, but not delegated. No `delegation`. | After `createAccount`, or after the stake fully cools down and is re-readied. |
| **activating** | Delegated this epoch, warming up. Not yet earning, not yet "active". | After `delegate`, during the same epoch (`activationEpoch === currentEpoch`). |
| **active** | Fully delegated and earning inflation rewards. | One epoch boundary after `delegate` (`activationEpoch < currentEpoch`, not deactivated). |
| **deactivating** | Scheduled to stop; cooling down this epoch. Still not withdrawable. | After `deactivate`, during the same epoch (`deactivationEpoch === currentEpoch`). |
| **inactive** | Cooldown complete. Delegated lamports are now withdrawable. | One epoch boundary after `deactivate` (`deactivationEpoch < currentEpoch`). |

Timing: warmup is **one epoch** and cooldown is **one epoch** (an epoch is ~2 to 3 days on mainnet). The network warmup/cooldown rate can stretch this when a large fraction of total stake is moving at once, but for a single account the practical rule is "active or withdrawable at the next epoch boundary."

```
create ──> undelegated
                │ delegate (stake authority)
                ▼
           activating ──(next epoch)──> active
                                          │ deactivate (stake authority)
                                          ▼
                                     deactivating ──(next epoch)──> inactive
                                                                       │ withdraw (withdraw authority)
                                                                       ▼
                                                                  closed (if drained) / undelegated (if redelegated)
```

## Reading status without getStakeActivation

`Connection.getStakeActivation` is **deprecated** in `@solana/web3.js` (deprecated since RPC v1.18) and the underlying `getStakeActivation` RPC method was dropped by validators, so the call fails at runtime against current nodes even though the method still type-checks. Derive status from the parsed account plus the current epoch instead.

```ts
const NOT_DEACTIVATED = 18446744073709551615n; // u64::MAX sentinel

function deriveStatus(delegation, currentEpoch: bigint) {
  if (!delegation) return "undelegated";
  const act = BigInt(delegation.activationEpoch);
  const deact = BigInt(delegation.deactivationEpoch);

  if (deact !== NOT_DEACTIVATED) {
    if (deact === currentEpoch) return "deactivating";
    if (deact < currentEpoch) return "inactive";
    // deact > currentEpoch is not normally reachable
  }
  if (act === currentEpoch) return "activating";
  if (act < currentEpoch) return "active";
  return "activating"; // act > currentEpoch edge: just delegated
}
```

Get the inputs from:

- `connection.getEpochInfo()` -> `.epoch` (current epoch).
- `connection.getParsedAccountInfo(stakePubkey)` -> `value.data.parsed.info.stake.delegation` (fields are decimal strings; convert with `BigInt`). If `parsed.info.stake` is `null`, the account is initialized but undelegated.

**Precision caveat:** `getStakeActivation` also returned the exact `active` / `inactive` lamport split mid-epoch (useful during partial warmup when the whole network is warming at the capped rate). The field-derivation above is at **epoch granularity** only. When asked for exact warming/cooling lamports mid-epoch, report status at epoch granularity and state that precise active lamports settle at the epoch boundary; do not fabricate an exact split. (If a supported precise source is needed, that is a gap to flag, not to guess.)

## Rent and minimums

- A stake account must hold the **rent-exempt reserve** at all times to stay open. Get it with `getMinimumBalanceForRentExemption(StakeProgram.space)`.
- Fund a new account with **reserve + stake**. The reserve is not delegated and is not part of the staked/earning amount.
- The **delegated** amount must meet the network **minimum delegation**. Fetch with `getStakeMinimumDelegation()` where available; the mainnet floor is currently 1 SOL (confirm at runtime rather than hardcoding).
- Withdrawing the entire balance, including the reserve, **closes** the account. Leave the reserve to keep it.

## Split rules

`StakeProgram.split` moves a portion of delegated lamports into a brand-new stake account:

- The new (split-destination) account needs its **own rent-exempt reserve**; pass it as the second argument to `StakeProgram.split(params, rentExemptReserve)`.
- The new account **inherits** the source's authorities, lockup, and delegation/activation state. No re-delegation needed.
- **Both** the remaining source and the new destination must still satisfy the **minimum delegation** after the split. Splitting an amount that leaves either side under the minimum fails.
- The split-destination keypair must **sign** (it is being created).
- Common use: partial unstake. Split off the portion you want to remove, then `deactivate` + `withdraw` only that account, leaving the rest active.

## Merge compatibility matrix

`StakeProgram.merge` drains a source stake account into a destination and closes the source. It is strict. Both accounts must share **identical authorities** and **identical lockups**, and their activation states must be compatible:

| Destination state | Source state | Mergeable? | Notes |
|-------------------|--------------|------------|-------|
| inactive | inactive | YES | Two undelegated/inactive accounts combine freely. |
| inactive | activating | YES | Inactive can absorb an activating stake. |
| active | active | YES (same vote account) | Both must be delegated to the **same** validator vote account. |
| activating | activating | YES (same epoch, same vote account) | Both activating in the **same** epoch toward the same vote account. |
| active | activating | NO | Mixed warmup states are not mergeable. |
| active | inactive | NO | An active stake cannot absorb an inactive one. |
| deactivating | (any) | NO | A cooling-down stake cannot participate in a merge. |
| any | any (different authorities or lockups) | NO | Authority/lockup mismatch always blocks merge. |

If a merge fails, check, in order: (1) authorities match exactly, (2) lockups match exactly, (3) both states appear in a "YES" row above, (4) for active/active and activating/activating, both point at the **same** vote account and the activating pair share the same epoch.

After a successful merge the source account is closed and its lamports (stake + reserve) are absorbed into the destination.
