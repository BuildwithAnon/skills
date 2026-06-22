# Sizing the compute budget so a transaction lands cheaply

A transaction that lands well is sized on two axes: how much compute it is allowed (CU limit), and how much account data it is allowed to load (loaded-accounts-data-size limit). Both default to values that are far larger than any normal transaction needs, and both feed into cost and scheduling. Get them tight and the priority fee gets cheaper and the transaction schedules better.

There are three Compute Budget Program instructions in play:

| Instruction | What it bounds | Default if unset |
|---|---|---|
| `setComputeUnitLimit({ units })` | max compute units the transaction may consume | 200,000 CU per instruction, capped at 1,400,000 CU per transaction |
| SetLoadedAccountsDataSizeLimit (u32 bytes) | max bytes of account data the transaction may load | 64 MB (64 * 1024 * 1024 bytes) |
| `setComputeUnitPrice({ microLamports })` | your bid per compute unit (the priority fee) | 0 (no priority) |

`ComputeBudgetProgram` in `@solana/web3.js` v1 only builds `setComputeUnitLimit`, `setComputeUnitPrice` (and the deprecated `requestUnits` / `requestHeapFrame`). It has no builder for SetLoadedAccountsDataSizeLimit, so build that instruction's raw bytes yourself (variant 4 followed by a u32-LE byte count) or use the `@solana-program/compute-budget` package from the kit/v2 stack.

This document covers the first two (sizing). The price (`microLamports`) decision is deferred to the `priority-fees` skill.

## 1. Compute unit limit, from simulation

Never guess the CU limit. Measure it.

```ts
const sim = await connection.simulateTransaction(tx, {
  sigVerify: false,           // simulate before signing
  replaceRecentBlockhash: true, // node substitutes a valid blockhash for the sim
});
if (sim.value.err) throw new Error("sim failed: " + JSON.stringify(sim.value.err));
const unitsConsumed = sim.value.unitsConsumed ?? 0;

const cuLimit = unitsConsumed > 0
  ? Math.ceil(unitsConsumed * 1.1)   // ~10% headroom
  : 1_000;                           // tiny fallback if the node did not report
```

- **Headroom** of about 10 percent absorbs small state changes between simulation and execution. A transaction that exceeds its CU limit fails with `ComputeBudgetExceeded`. Too tight risks that failure; too wide overpays.
- **Widen headroom to ~20 percent** for instructions whose cost depends on account state, such as creating accounts, growing account data, or iterating over a variable-length list.
- **Re-simulate** when the instruction set or relevant account state changes materially. A stale `unitsConsumed` from a different code path is not safe to reuse.

Note that the compute-budget instructions themselves cost a small fixed amount of CU. Simulating the transaction with placeholder compute-budget instructions already present, or simply adding the ~10 percent headroom, covers this.

## 2. Loaded-accounts-data-size limit

This is the step most agents miss. Even with a perfect CU limit, the runtime charges compute proportional to the **data size of the accounts the transaction loads**. If you do not set a limit, the runtime assumes the default 64 MB cap, which silently inflates the effective compute accounting and can push you toward the per-transaction CU ceiling and worse scheduling.

Size it to the real footprint:

```ts
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

// Sum the data length of every account the transaction loads (writable + readonly),
// including programs it invokes. Round up with margin.
const loadedBytes = accountsTheTxTouches.reduce((sum, acc) => sum + acc.dataLen, 0);
const dataSizeLimit = Math.ceil(loadedBytes * 1.1); // small margin

// web3.js v1 has no builder, so encode the instruction manually:
// variant 4 (SetLoadedAccountsDataSizeLimit) + a u32-LE byte count.
const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  "ComputeBudget111111111111111111111111111111"
);
const data = Buffer.alloc(5);
data.writeUInt8(4, 0);
data.writeUInt32LE(dataSizeLimit, 1);
const sizeIx = new TransactionInstruction({
  programId: COMPUTE_BUDGET_PROGRAM_ID,
  keys: [],
  data,
});
```

Practical ways to find the real bytes:

- For each account in the message (writable and readonly), use the on-chain account's data length. `connection.getMultipleAccountsInfo([...keys])` returns each account's `data`, whose length is the loaded size. Sum them and include the invoked program accounts.
- Add a modest margin (about 10 percent) so a small change in an account's size does not trip the limit.
- If unsure of the exact set, err on the side of a value comfortably above your measured sum but well under 64 MB. Even a loose-but-real value (for example a few hundred KB for a handful of token accounts) is dramatically better than the 64 MB default.

Setting `setComputeUnitLimit` alone is not enough: pair it with `setLoadedAccountsDataSizeLimit` to avoid the silent data-size waste.

## 3. How sizing interacts with the priority fee

The priority fee is per compute unit:

```
priorityFeeLamports = ceil(computeUnitLimit * microLamports / 1_000_000)
```

So the CU limit is a direct multiplier on cost. Two consequences:

1. **A tight CU limit makes the same urgency cheaper.** Halving the limit halves the fee at the same price. This is why sizing comes before pricing.
2. **A tight CU limit and data-size limit improve scheduling.** The scheduler favors transactions that declare smaller, predictable resource use, so right-sizing helps the transaction land independent of price.

The actual `microLamports` value (the price) is chosen in the `priority-fees` skill, using `getRecentPrioritizationFees` percentiles scoped to your writable accounts, or a provider estimate such as Helius `getPriorityFeeEstimate`. This skill's job is only to ensure the limit is tight so that whatever price you pick is not multiplied against a bloated limit.

## Order of the instructions

Prepend the three compute-budget instructions to the front of the instruction list, conventionally in the order: CU limit, loaded-accounts-data-size limit, CU price. Position does not change correctness, but keeping them first is the standard and keeps simulation and inspection predictable.

```ts
const instructions = [
  ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
  sizeIx, // SetLoadedAccountsDataSizeLimit, built manually above
  ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), // value from the priority-fees skill
  ...bodyInstructions,
];
```

## Checklist

- [ ] Simulated with `sigVerify: false`, `replaceRecentBlockhash: true`; read `unitsConsumed`.
- [ ] CU limit = `ceil(unitsConsumed * 1.1)` (1.2 for state-dependent instructions).
- [ ] Loaded-accounts-data-size limit sized to the real account data (not the 64 MB default).
- [ ] Priority-fee price obtained from the `priority-fees` skill, not guessed here.
- [ ] All three compute-budget instructions prepended before the body instructions.
