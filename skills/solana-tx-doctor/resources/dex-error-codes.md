# DEX and Slippage Custom Error Codes (the 0x1771 family)

This is the highest-leverage table in the skill. Helius post-mortems report that **over 80% of failed Solana transactions are `0x1771` (decimal 6001), which means "exceeded desired slippage"**. If you see `custom program error: 0x1771` or `{ Custom: 6001 }` on a swap, you are almost certainly looking at a slippage revert, not a bug. Treat slippage as the default hypothesis for any failed swap and confirm it from the logs or the IDL.

## Why slippage dominates

A swap instruction carries a minimum-out (or maximum-in) amount computed from a quote. Between quote and execution the pool price moves. If the realized output crosses the bound, the program reverts with its slippage error. The transaction **landed and reverted**: fees were burned, the swap did not happen. This is NOT safe to blind-retry. The fix is to refresh the quote, widen the tolerance, and rebuild on a fresh blockhash.

`0x1771` is hex. Convert it: `parseInt("0x1771", 16) === 6001`. It is the second entry (index 1) of a `#[error_code]` enum that starts at 6000, which is why so many Anchor-style DEXes land on exactly this number for their slippage check. Always confirm the meaning against the specific program (logs or IDL), because the same number is a different error in a different program.

## Common DEX slippage and swap errors

Codes below are the slippage or swap-failure codes most agents will actually hit. Confirm against the failing program id from the CPI stack (see decode-reference.md Path 7) before trusting a row. `0x...` is the log form, decimal is the `meta.err` form.

| Program | Program id | Code (hex / dec) | Name | Meaning | Remediation |
|---------|------------|------------------|------|---------|-------------|
| Jupiter Aggregator v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | `0x1771` / 6001 | SlippageToleranceExceeded | Realized out below the min-out from the quote. | Refresh the quote, raise `slippageBps`, rebuild on a fresh blockhash. |
| Jupiter Aggregator v6 | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | `0x1772` / 6002 | InvalidCalculation / route math | Route or amount math failed (often a stale or impossible route). | Re-quote, do not reuse the old route. |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | `0x1e` / 30 | ExceededSlippage | Out amount below `minimum_amount_out`. | Re-quote, raise slippage, rebuild. |
| Raydium CLMM | `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK` | `0x1771` / 6001 | (slippage / price-limit class) | Price moved past the limit or min-out. | Re-quote, widen tolerance, rebuild. |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | `0x1781` / 6017 | AmountOutBelowMinimum | Out below the supplied minimum. | Re-quote, raise min-out tolerance, rebuild. |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | `0x1782` / 6018 | AmountInAboveMaximum | Exact-out cost exceeded the max-in. | Re-quote, raise max-in tolerance, rebuild. |
| Orca Whirlpools | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | `0x1799` / 6041 | TokenMinSubceeded (older builds) | Min-out not met (legacy variant). | Re-quote, widen tolerance, rebuild. |
| pump.fun (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `0x1772` / 6002 | TooMuchSolRequired | SOL cost to buy exceeded `max_sol_cost`. | Raise `max_sol_cost` (more slippage), re-quote, rebuild. |
| pump.fun (bonding curve) | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | `0x1773` / 6003 | TooLittleSolReceived | SOL received on sell below `min_sol_output`. | Lower `min_sol_output` (more slippage), re-quote, rebuild. |
| pump.fun AMM (PumpSwap) | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | `0x1771` / 6001 | (slippage / exceeded out-in bound) | Out below or in above the bound. | Re-quote, widen tolerance, rebuild. |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | `0x1771` / 6001 | ExceededAmountSlippageTolerance | Out outside the slippage band for the active bin. | Re-quote, raise slippage, rebuild. |
| Meteora DLMM | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | `0x1772` / 6002 | ExceededBinSlippageTolerance | Active bin moved past the allowed bin slippage. | Re-quote, raise bin slippage, rebuild. |
| Meteora Dynamic AMM (pools) | `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB` | `0x10` / 16 | ExceededSlippage | Out below `minimum_out_amount`. | Re-quote, raise slippage, rebuild. |

Verify a row against the live program before quoting it as fact: the same number means different things in different programs, and DEXes renumber errors between versions. The reliable move is always: convert the hex to decimal, identify the failing program from the CPI stack, then look the number up in THAT program's IDL `errors` array (decode-reference.md Path 3). The table above is a fast first guess, not a substitute for the per-program lookup.

## The slippage remediation, stated once

Slippage is a price-moved-on-you revert, not a code bug. The safe sequence is identical across every DEX:

1. **Do not blind-retry the same transaction.** It reverted on chain and is final. Resending the same bytes either reverts again or, after expiry, does nothing.
2. **Refresh the quote.** The old quote is stale by definition; that is why it reverted.
3. **Widen the tolerance** on the new quote: raise `slippageBps` (Jupiter, Raydium, Orca, Meteora) or `max_sol_cost` / lower `min_sol_output` (pump.fun). Match the tolerance to observed volatility; do not set it so wide that you accept a bad fill.
4. **Rebuild on a fresh blockhash** and resend, then confirm against the new `lastValidBlockHeight`.

Optionally add a priority fee (`ComputeBudgetProgram.setComputeUnitPrice`) so the rebuilt transaction lands faster and the new quote stays fresh long enough to execute.

## References

- Jupiter error codes: https://station.jup.ag/docs
- Raydium program errors: https://github.com/raydium-io/raydium-amm
- Orca Whirlpools errors: https://github.com/orca-so/whirlpools
- pump.fun program: program id `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
- Meteora DLMM: https://github.com/MeteoraAg/dlmm-sdk
- Helius on failed-transaction causes: https://www.helius.dev/blog
