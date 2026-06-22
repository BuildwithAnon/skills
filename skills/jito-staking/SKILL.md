---
name: jito-staking
description: Mint and redeem JitoSOL liquid staking against the single Jito SPL Stake Pool, and deposit into Jito restaking vaults to mint a VRT. Use when staking SOL for JitoSOL, unstaking JitoSOL back to SOL, reading the JitoSOL exchange rate, or working with Jito restaking (NCN/operator delegation) and Vault Receipt Tokens (VRT). Keywords: JitoSOL, liquid staking, SPL stake pool, depositSol, withdrawStake, Jito restaking, vault, VRT, vault receipt token, mint_to, enqueue withdrawal, withdrawal ticket, NCN, operator. This is Jito-native only (single pool, no routing); for routing or comparing across many LSTs use the sanctum skill.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Jito Staking and Restaking

Two Jito-native flows in one skill: (1) JitoSOL liquid staking, which is a standard SPL Stake Pool, where you deposit SOL and receive the rewards-bearing JitoSOL token and later redeem it back to SOL; and (2) Jito restaking, where you deposit an asset into a Jito vault and receive a Vault Receipt Token (VRT) that is a pro-rata claim on that vault. Both are single-protocol operations against Jito's own on-chain programs. Neither one routes or compares across other liquid staking tokens.

## Overview

JitoSOL is not a custom program. It is an instance of the **SPL Stake Pool** program, so the entire JitoSOL mint/redeem flow is the standard stake-pool flow pointed at the Jito pool. You use the `@solana/spl-stake-pool` JavaScript package (built on the classic `@solana/web3.js` `Connection`), point it at the JitoSOL stake pool account, and call `depositSol` to mint JitoSOL or `withdrawStake` to redeem. JitoSOL is rewards-bearing: its value grows against SOL each epoch, so 1 JitoSOL is worth more than 1 SOL and the deposit/withdraw amounts are **not** 1:1.

Jito restaking is a separate concern with two on-chain programs of its own: a **Restaking** program (an NCN/operator registry plus delegation bookkeeping) and a **Vault** program (deposits, VRT mint and burn). A user deposits an underlying asset into a specific vault and the program mints them a VRT, an SPL token representing a pro-rata share of that vault. The vault and restaking SDKs are built on `@solana/kit` (the newer Solana JS stack), **not** classic `@solana/web3.js`, so the calling convention differs from the JitoSOL side of this skill. Do not assume one style across both flows.

**Scope and dedup.** This skill is Jito-native only:
- JitoSOL: mint/redeem against the **single** Jito SPL Stake Pool. No routing, no aggregation, no cross-LST comparison.
- Restaking: deposit an asset into a Jito vault to mint a VRT, and the two-step delayed withdrawal back out.

If the task is to **route, swap, or compare across multiple LSTs** (mSOL, bSOL, jitoSOL, INF, and so on), that is the **sanctum** skill, not this one. Sanctum is a multi-LST aggregator/router; this skill never leaves the Jito pool or a Jito vault. If a user asks for an "instant" JitoSOL exit and the pool's instant path is unavailable (it usually is, see below), the instant route lives on a secondary market (Jupiter or Sanctum), which is again outside this skill.

Use this skill when you have one of these tasks:
1. Stake SOL to receive JitoSOL (mint).
2. Unstake JitoSOL back to SOL (redeem), including the delayed stake-account path.
3. Read the JitoSOL exchange rate or pool state, or update the pool before a deposit/withdraw.
4. Deposit an asset into a Jito restaking vault to mint a VRT, or withdraw via the two-step ticket flow.

All program ids, the pool address, the JitoSOL mint, and the package versions are in `resources/addresses.md`. The restaking/vault mechanics (VRT, fees, two-step withdrawal) are in `resources/restaking-vaults.md`.

## Instructions

Pick the flow first, then run its steps in order. Each step has a success criterion.

### Step 0: Route to the correct flow

- Task mentions **JitoSOL**, staking SOL, unstaking to SOL, or the JitoSOL exchange rate -> **JitoSOL liquid staking** (Steps 1 to 5).
- Task mentions a **Jito vault**, a **VRT**, restaking, NCN/operator delegation, or minting a receipt token from a deposited asset -> **Jito restaking** (Steps 6 to 8).
- Task mentions routing, swapping, or comparing **multiple** LSTs -> this is **not** this skill. Hand off to `sanctum`.

**Success criterion:** You have classified the task as JitoSOL liquid staking, Jito restaking, or out-of-scope (sanctum).

### Step 1: Load the JitoSOL stake pool and read its state

Use the classic `@solana/web3.js` `Connection` and `@solana/spl-stake-pool`. Fetch the pool account.

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { getStakePoolAccount } from "@solana/spl-stake-pool";

const JITO_STAKE_POOL = new PublicKey(
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb"
);
const connection = new Connection(process.env.RPC_URL!, "confirmed");
const pool = await getStakePoolAccount(connection, JITO_STAKE_POOL);
```

From `pool.account.data` read `totalLamports`, `poolTokenSupply`, the fee fields, and `lastUpdateEpoch`. The JitoSOL/SOL exchange rate is `totalLamports / poolTokenSupply` (both are `BN`/bigint lamport values). Because JitoSOL is rewards-bearing this rate is `> 1` and grows each epoch.

**Success criterion:** You have the pool account, the current exchange rate, and `lastUpdateEpoch`.

### Step 2: Update the pool if it is stale this epoch

The stake pool must be refreshed once per epoch. If `lastUpdateEpoch` is behind the current epoch, a deposit or withdraw can fail. Call `updateStakePool` before mutating the pool.

```ts
import { updateStakePool } from "@solana/spl-stake-pool";
const epochInfo = await connection.getEpochInfo();
if (Number(pool.account.data.lastUpdateEpoch) < epochInfo.epoch) {
  const { updateListInstructions, finalInstructions } =
    await updateStakePool(connection, pool);
  // send updateListInstructions (may be several txs) then finalInstructions
}
```

In `@solana/spl-stake-pool@1.1.8`, `updateStakePool` returns `{ updateListInstructions, finalInstructions }` (both `TransactionInstruction[]`): send the update-list instructions first (chunked into one or more transactions), then the final instructions.

**Success criterion:** `lastUpdateEpoch` equals the current epoch, or you have sent the update instructions for this epoch.

### Step 3: Mint JitoSOL by depositing SOL

Call `depositSol` with the pool, the funding wallet, and the **lamport** amount. It returns the instructions and signers to assemble and send. JitoSOL out is `lamports / exchangeRate`, not equal to `lamports`. The JitoSOL pool's SOL deposit fee is approximately 0%, but read the live fee from the pool account rather than hardcoding it.

```ts
import { depositSol } from "@solana/spl-stake-pool";
const { instructions, signers } = await depositSol(
  connection,
  JITO_STAKE_POOL,
  walletPublicKey,
  1_000_000_000 // 1 SOL in lamports (a number, per the SDK signature)
);
// build a Transaction from instructions, add the wallet as signer + any returned signers, send
```

For staking an existing native **stake account** instead of raw SOL, use `depositStake`. Stake-account deposits on the Jito pool route through a separate **stake-deposit-interceptor** program; account for that program id and its accounts when building a stake deposit. See `resources/addresses.md`.

**Success criterion:** A confirmed transaction that debits SOL from the wallet and credits JitoSOL, with the JitoSOL amount consistent with the exchange rate.

### Step 4: Redeem JitoSOL (choose the right exit)

JitoSOL has two on-pool exits, and the instant one is usually unavailable:

- `withdrawSol` (instant, from the reserve): on the Jito pool this is **usually blocked** (the pool keeps little or no instant SOL reserve). Do not assume it works. If it reverts or is disabled, fall back to `withdrawStake`.
- `withdrawStake` (delayed): the supported exit. It burns JitoSOL and returns a **stake account** delegated to one of the pool's validators. That stake account must be **deactivated** and then, after the ~1-epoch cooldown, withdrawn to SOL with the native Stake program. This is not instant.

```ts
import { withdrawStake } from "@solana/spl-stake-pool";
const { instructions, signers } = await withdrawStake(
  connection,
  JITO_STAKE_POOL,
  walletPublicKey,
  500_000_000 // JitoSOL (pool-token) amount to redeem, in base units (a number)
);
// send -> receive a stake account; then StakeProgram.deactivate, wait ~1 epoch, StakeProgram.withdraw
```

If the user needs a truly **instant** JitoSOL exit, tell them the on-pool instant path is unavailable and that instant liquidity comes from a secondary market (Jupiter or Sanctum), which is the `sanctum` skill, not this one.

**Success criterion:** Either an instant `withdrawSol` confirmed (rare), or a `withdrawStake` that produced a stake account, plus a clear plan to deactivate and withdraw after the cooldown.

### Step 5: Complete the delayed unstake

After `withdrawStake`, finish the native stake-account lifecycle: `StakeProgram.deactivate` the returned stake account, wait roughly one epoch for cooldown, then `StakeProgram.withdraw` the lamports to the wallet. The full runnable flow is in `examples/unstake-jitosol.ts`. For deep stake-account lifecycle detail (warmup, cooldown, deriving activation status without the removed `getStakeActivation` RPC), defer to the `solana-native-staking` skill.

**Success criterion:** The stake account is deactivated and, after cooldown, withdrawn to SOL.

### Step 6: Identify the restaking vault and read its parameters

Restaking touches two programs: the **Vault** program (deposits, VRT mint/burn) and the **Restaking** program (NCN/operator registry and delegation). A full integration touches both; a plain deposit-to-VRT touches the Vault program. Use the `@jito-foundation/vault-sdk` and `@jito-foundation/restaking-sdk` packages, which are built on `@solana/kit` (not classic `@solana/web3.js`).

Before depositing, fetch the **specific vault** account and read its `DEPOSIT_FEE_BPS`, `WITHDRAWAL_FEE_BPS`, the program fee, the underlying-asset mint, and the VRT mint. These are set at vault init and differ per vault. Do **not** assume zero fees. See `resources/restaking-vaults.md`.

**Success criterion:** You have the target vault account, its underlying mint, its VRT mint, and its live deposit/withdrawal/program fees.

### Step 7: Deposit the asset to mint a VRT

Deposit the underlying asset; the program mints a VRT (an SPL token) to the depositor as a pro-rata claim on the vault. The on-chain instruction is `mint_to`, taking an input amount and a **minimum-out** slippage bound (so the depositor is protected if the vault ratio moved). Pass a `minAmountOut` derived from the vault ratio minus your slippage tolerance.

In `@jito-foundation/vault-sdk@1.0.0` (a `@solana/kit` codama client) the deposit helper is `getMintToInstruction`, taking a `MintToInput` for the accounts plus `{ amountIn, minAmountOut }`. The on-chain instruction is `mint_to`; `minAmountOut` is the slippage bound enforced by the program.

**Success criterion:** A confirmed deposit that mints VRT to the user, with the VRT amount at or above your `minAmountOut`.

### Step 8: Withdraw from the vault (two-step, delayed)

Vault withdrawals are **not instant**. They are a two-step cooldown flow:

1. `enqueue_withdrawal` burns or escrows VRT and creates a **VaultStakerWithdrawalTicket**.
2. After the cooldown (~2 epochs, roughly 4 to 5 days), `burn_withdrawal_ticket` releases the underlying asset to the user.

Track the ticket account between the two steps and only run step 2 once the cooldown has elapsed. Withdrawal fees are charged per the vault's `WITHDRAWAL_FEE_BPS` plus the program fee. See `resources/restaking-vaults.md`.

**Success criterion:** A withdrawal ticket created in step 1, and after the cooldown, a burn that releases the underlying asset net of fees.

## Examples

### Example 1: Stake 1 SOL for JitoSOL

User input: "Stake 1 SOL into JitoSOL."

The agent runs:

1. **Route:** mentions JitoSOL and staking SOL -> JitoSOL liquid staking.
2. **Load pool** with `getStakePoolAccount(connection, Jito4APyf...)`; compute rate = `totalLamports / poolTokenSupply` (e.g. ~1.18, so 1 SOL mints ~0.847 JitoSOL).
3. **Update if stale:** `lastUpdateEpoch` < current epoch -> send `updateStakePool` instructions.
4. **Mint:** `depositSol(connection, pool, wallet, 1_000_000_000)`, assemble the transaction, sign, send.
5. **Report:** confirmed signature and the JitoSOL received, noting it is not 1:1 because JitoSOL is rewards-bearing.

`examples/stake-jitosol.ts` runs exactly this flow.

### Example 2: Unstake JitoSOL back to SOL

User input: "Unstake my JitoSOL, I have 0.5 JitoSOL."

1. **Route:** unstaking JitoSOL -> JitoSOL liquid staking.
2. **Update** the pool if stale.
3. **Try instant?** `withdrawSol` on the Jito pool is usually blocked, so go straight to the delayed path (or attempt instant and catch the revert).
4. **Redeem (delayed):** `withdrawStake(connection, pool, wallet, 500_000_000)` returns a stake account.
5. **Finish:** `StakeProgram.deactivate` the stake account, wait ~1 epoch, `StakeProgram.withdraw` to the wallet.
6. **Report:** explain the wait and that an instant exit is only available on a secondary market (Jupiter/Sanctum), not the pool.

`examples/unstake-jitosol.ts` runs the `withdrawStake` plus deactivate/withdraw flow.

### Example 3: Deposit into a Jito restaking vault for a VRT

User input: "Deposit into Jito vault <VAULT> and mint the VRT."

1. **Route:** vault + VRT -> Jito restaking (Vault program, `@jito-foundation/vault-sdk` on `@solana/kit`).
2. **Read vault params:** fetch the vault account; read underlying mint, VRT mint, `DEPOSIT_FEE_BPS`, `WITHDRAWAL_FEE_BPS`, program fee, and current ratio.
3. **Compute minAmountOut** from the ratio minus slippage.
4. **Deposit** the underlying asset; the program runs `mint_to` and mints VRT to the user.
5. **Report:** VRT minted, fee charged, and that withdrawing later is a two-step ~2-epoch ticket flow (`enqueue_withdrawal` then `burn_withdrawal_ticket`), not instant.

## Guidelines

- **DO** treat JitoSOL as a standard SPL Stake Pool. The whole mint/redeem flow is `@solana/spl-stake-pool` pointed at the Jito pool address; there is no custom JitoSOL program.
- **DO** call `updateStakePool` before any deposit or withdraw if the pool is stale this epoch, or the operation can fail.
- **DO** read the exchange rate and fees live from the pool account. JitoSOL amounts are never 1:1 with SOL.
- **DO** plan for `withdrawStake` (delayed) as the JitoSOL exit. Treat `withdrawSol` (instant) as usually blocked on the Jito pool.
- **DO** read each restaking vault's own `DEPOSIT_FEE_BPS`, `WITHDRAWAL_FEE_BPS`, and program fee from the vault account. They are per-vault and not zero by default.
- **DO** pass a `minAmountOut` slippage bound when minting a VRT.
- **DO** keep the two SDK calling conventions straight: `@solana/spl-stake-pool` uses classic `@solana/web3.js` `Connection`; the Jito vault/restaking SDKs use `@solana/kit`.
- **DON'T** assume an instant JitoSOL exit from the pool. If the user needs instant, send them to a secondary market (the `sanctum` skill), not this pool.
- **DON'T** assume vault withdrawals are instant. They are a two-step ~2-epoch ticket flow.
- **DON'T** hardcode fees, APY, or the exchange rate. They are point-in-time; read them on chain.
- **DON'T** treat this as a router. If the task spans multiple LSTs (swap/compare/route), it is `sanctum`, not this skill.
- **DON'T** mix the SDK styles. Do not pass a `@solana/web3.js` `Connection` into a `@solana/kit`-based vault call or vice versa.

## Common Errors

### Error: deposit or withdraw fails after epoch rollover
**Cause:** The stake pool was not updated this epoch; its accounting is stale.
**Solution:** Call `updateStakePool` (send the update-list instructions then the final instructions) before `depositSol` / `withdrawStake`. Check `lastUpdateEpoch` against `getEpochInfo().epoch` first.

### Error: `withdrawSol` reverts or is rejected on the Jito pool
**Cause:** The Jito pool usually holds little or no instant SOL reserve, so the instant withdraw path is unavailable.
**Solution:** Use `withdrawStake` (delayed): redeem to a stake account, deactivate it, wait ~1 epoch, withdraw to SOL. For an instant exit, use a secondary market (Jupiter/Sanctum), which is the `sanctum` skill.

### Error: got far less SOL than JitoSOL deposited (or vice versa)
**Cause:** Assuming a 1:1 rate. JitoSOL is rewards-bearing, so its value is `> 1` SOL and grows each epoch.
**Solution:** Compute amounts from the live rate `totalLamports / poolTokenSupply`. Never assume parity.

### Error: vault deposit mints fewer VRT than expected, or unexpected fee taken
**Cause:** Assuming zero fees. Each vault sets `DEPOSIT_FEE_BPS` / `WITHDRAWAL_FEE_BPS` plus a program fee at init.
**Solution:** Read the specific vault's fees and current ratio from its account, and pass a `minAmountOut` that accounts for the deposit fee and slippage.

### Error: vault withdrawal "stuck" or asset not received
**Cause:** Treating the vault withdrawal as a single instant call. It is two steps with a ~2-epoch cooldown.
**Solution:** Run `enqueue_withdrawal` to create the VaultStakerWithdrawalTicket, wait the cooldown (~2 epochs, ~4 to 5 days), then `burn_withdrawal_ticket` to release the asset.

### Error: SDK type/calling-convention mismatch between flows
**Cause:** Mixing the classic-web3.js JitoSOL SDK with the `@solana/kit`-based vault/restaking SDKs.
**Solution:** Use `@solana/web3.js` `Connection` for `@solana/spl-stake-pool`, and `@solana/kit` clients/signers for `@jito-foundation/vault-sdk` and `@jito-foundation/restaking-sdk`. Do not pass one into the other.

## References

- `resources/addresses.md` - JitoSOL stake pool address, JitoSOL mint, SPL Stake Pool program id, stake-deposit-interceptor note, Jito Restaking and Vault program ids, and all package names with versions.
- `resources/restaking-vaults.md` - what a VRT is, the deposit (`mint_to`) flow with `minAmountOut`, the two-step delayed withdrawal (`enqueue_withdrawal` -> ticket -> `burn_withdrawal_ticket`), and the per-vault fee model.
- `examples/stake-jitosol.ts` - mint JitoSOL via `depositSol` from `@solana/spl-stake-pool` (classic `@solana/web3.js`), including the stale-pool update check.
- `examples/unstake-jitosol.ts` - redeem JitoSOL via `withdrawStake`, then the native deactivate + withdraw cooldown flow.
- SPL Stake Pool program docs: https://spl.solana.com/stake-pool
- `@solana/spl-stake-pool` package: https://www.npmjs.com/package/@solana/spl-stake-pool
- Jito stake/unstake reference implementation: https://github.com/jito-foundation/jito-stake-unstake-reference
- Jito Restaking docs: https://docs.restaking.jito.network
- Jito GitHub (restaking/vault programs and SDKs): https://github.com/jito-foundation
