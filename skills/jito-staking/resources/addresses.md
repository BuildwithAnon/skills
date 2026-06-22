# Jito Addresses, Programs, and Packages

All mainnet. Verify any value on chain before signing; treat fees, APY, and the exchange rate as point-in-time.

## JitoSOL liquid staking (SPL Stake Pool)

JitoSOL is a standard SPL Stake Pool. There is no custom JitoSOL program. The mint/redeem flow is the SPL Stake Pool flow pointed at the Jito pool.

| Item | Address |
|------|---------|
| JitoSOL stake pool account | `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb` |
| JitoSOL mint | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| SPL Stake Pool program | `SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy` |

**Stake-account deposits:** depositing a native **stake account** (not raw SOL) into the Jito pool routes through a separate **stake-deposit-interceptor** program. When building a `depositStake` flow, account for that program and its accounts; take its program id from the Jito stake/unstake reference implementation (see the note under Packages below).

### Package

| Package | Version | Stack |
|---------|---------|-------|
| `@solana/spl-stake-pool` | `1.1.8` | classic `@solana/web3.js` `Connection` |

Key functions (all on `@solana/spl-stake-pool`):
- `getStakePoolAccount(connection, poolPubkey)` - fetch and decode the pool account (read rate, supply, fees, `lastUpdateEpoch`).
- `updateStakePool(connection, stakePool)` - refresh the pool for the current epoch; returns instruction groups to assemble. **Call before deposit/withdraw if stale**, or the operation can fail.
- `depositSol(connection, stakePool, from, lamports, ...)` - deposit SOL, mint JitoSOL. SOL deposit fee on the Jito pool is approximately 0% (read it live).
- `depositStake(...)` - deposit a native stake account; routes via the stake-deposit-interceptor program.
- `withdrawSol(...)` - instant withdraw from the reserve. **Usually blocked on the Jito pool.**
- `withdrawStake(...)` - delayed withdraw; returns a stake account to deactivate (~1 epoch cooldown) then withdraw to SOL.

JitoSOL is rewards-bearing: rate = `totalLamports / poolTokenSupply` is `> 1` and grows each epoch. Amounts are **not** 1:1 with SOL.

Reference implementation: https://github.com/jito-foundation/jito-stake-unstake-reference

## Jito Restaking and Vaults

Two on-chain programs. A full integration touches both; a plain deposit-to-VRT touches the Vault program.

| Program | Address | Role |
|---------|---------|------|
| Restaking program | `RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q` | NCN / operator registry and delegation bookkeeping |
| Vault program | `Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8` | deposits, VRT mint/burn, withdrawal tickets |

### Packages

| Package | Version | Stack |
|---------|---------|-------|
| `@jito-foundation/vault-sdk` | `1.0.0` | `@solana/kit` (not classic web3.js) |
| `@jito-foundation/restaking-sdk` | `1.0.0` | `@solana/kit` (not classic web3.js) |

**Calling-convention warning:** the vault/restaking SDKs use `@solana/kit`, while `@solana/spl-stake-pool` (JitoSOL) uses classic `@solana/web3.js` `Connection`. Do not mix them in one call path.

A VRT (Vault Receipt Token) is an SPL token = pro-rata claim on a vault. Deposit underlying asset -> program runs the Rust `mint_to` instruction (`amountIn` + `minAmountOut` slippage bound) -> VRT minted. Withdrawal is two-step and delayed: `enqueue_withdrawal` creates a VaultStakerWithdrawalTicket, then after ~2 epochs `burn_withdrawal_ticket` releases the asset. Fees (`DEPOSIT_FEE_BPS`, `WITHDRAWAL_FEE_BPS`, program fee) are set per vault at init; read them from the specific vault. See `restaking-vaults.md`.

`@jito-foundation/vault-sdk@1.0.0` is a `@solana/kit` codama client. Key exports: `JITO_VAULT_PROGRAM_ADDRESS`, `fetchVault` / `getVaultDecoder` (read the vault), `getMintToInstruction` (deposit -> VRT), `getEnqueueWithdrawalInstruction` and `getBurnWithdrawalTicketInstruction` (the two-step withdrawal).

**One value still to confirm on chain:** the stake-deposit-interceptor program id (used only for `depositStake`, not `depositSol`). Take it from the Jito stake/unstake reference repo at build time. Live fees and APY are point-in-time, so always read them on chain.
