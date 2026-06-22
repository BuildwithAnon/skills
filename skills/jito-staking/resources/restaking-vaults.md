# Jito Restaking Vaults: VRT, Deposit, Two-Step Withdrawal, Fees

Jito restaking lets a user deposit an asset into a vault and receive a **VRT** (Vault Receipt Token). This is distinct from JitoSOL liquid staking: restaking has its own two on-chain programs (Restaking and Vault) and SDKs built on `@solana/kit`. See `addresses.md` for program ids and package versions.

## What a VRT is

A VRT is a standard SPL token that represents a **pro-rata claim** on a single vault's holdings. Holding `x` VRT out of a `T`-token supply entitles you to `x / T` of the vault's underlying assets (net of fees). The VRT-to-underlying ratio moves as the vault accrues or loses value, so deposits and redemptions are not 1:1 with the underlying. Each vault has its own VRT mint, its own underlying-asset mint, and its own fee parameters.

## Two programs

- **Vault program** (`Vau1t6sLNxnzB7ZDsef8TLbPLfyZMYXH8WTNqUdm9g8`): deposits, VRT mint/burn, withdrawal tickets. A plain deposit-to-VRT and a withdrawal touch only this program.
- **Restaking program** (`RestkWeAVL8fRGgzhfeoqFhsqKRchg6aa1XrcH96z4Q`): the NCN (Node Consensus Network) and operator registry plus delegation bookkeeping. A full restaking integration (delegating vault assets to operators securing an NCN) touches this program too.

Use `@jito-foundation/vault-sdk@1.0.0` and `@jito-foundation/restaking-sdk@1.0.0`. Both are built on `@solana/kit`, not classic `@solana/web3.js`.

## Read the vault first

Before any deposit, fetch the **specific vault** account and read:
- the underlying-asset mint,
- the VRT mint,
- `DEPOSIT_FEE_BPS`,
- `WITHDRAWAL_FEE_BPS`,
- the program fee,
- the current VRT-to-underlying ratio.

These are set per vault at initialization and differ between vaults. **Do not assume any of them are zero.**

## Deposit: mint a VRT

Deposit the underlying asset; the program mints VRT to the depositor. The on-chain Rust instruction is `mint_to`, which takes:
- an **input amount** (`amountIn`) of the underlying asset, and
- a **minimum-out** bound (`minAmountOut`) on the VRT minted, protecting the depositor if the ratio moved between quote and execution.

Compute `minAmountOut` from the current ratio minus your slippage tolerance and the deposit fee. The deposit fee (`DEPOSIT_FEE_BPS` plus program fee) reduces the VRT you receive.

In `@jito-foundation/vault-sdk@1.0.0` (a `@solana/kit` codama-generated client) the deposit helper is `getMintToInstruction(MintToInput)` with `{ amountIn, minAmountOut }`. Read the vault account with `fetchVault` and the program id is exported as `JITO_VAULT_PROGRAM_ADDRESS`.

## Withdrawal: two steps, delayed (~2 epochs)

Withdrawals are **not** instant. They are a cooldown flow with an intermediate ticket account:

1. **`enqueue_withdrawal`** (TS: `getEnqueueWithdrawalInstruction`) - burns or escrows the VRT and creates a **VaultStakerWithdrawalTicket** account recording the claim. Persist this ticket account address; you need it in step 2.
2. **Cooldown** - roughly **2 epochs** (about **4 to 5 days**). The exact duration is epoch-driven; do not run step 2 early.
3. **`burn_withdrawal_ticket`** (TS: `getBurnWithdrawalTicketInstruction`) - after the cooldown, releases the underlying asset to the user, net of the withdrawal fee (`WITHDRAWAL_FEE_BPS` plus program fee).

Because of the cooldown, a vault VRT is not a same-block exit. If a user needs immediate liquidity for a VRT, that would be a secondary market, which is outside this skill.

## Fee model summary

| Fee | Where set | Applies to |
|-----|-----------|-----------|
| `DEPOSIT_FEE_BPS` | per vault, at init | deposit (reduces VRT minted) |
| `WITHDRAWAL_FEE_BPS` | per vault, at init | withdrawal (reduces asset released) |
| Program fee | per vault, at init | both deposit and withdrawal |

Always read these from the target vault account at runtime. They are point-in-time and vary by vault.
