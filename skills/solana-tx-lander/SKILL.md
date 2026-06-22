---
name: solana-tx-lander
description: The RPC-agnostic procedure to reliably LAND a Solana transaction under congestion. Use when a transaction needs to land, confirm, and survive retry, or when a send is dropping, timing out, or stuck pending. Covers the full build, simulate, size compute, set priority fee, send, and confirm-with-retry loop above any RPC. Keywords: land transaction, confirm, retry, compute unit limit, blockhash expiry, transaction not confirmed, dropped transaction, lastValidBlockHeight, getSignatureStatuses, rebroadcast, VersionedTransaction, address lookup tables, transaction too large.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Land a Solana Transaction Under Congestion

Get a Solana transaction confirmed when the network is busy by owning every step from build to confirmation, never trusting an RPC default to do it for you. Sending and hoping is the single most common agent failure mode on Solana: the transaction goes out, the RPC reports nothing useful, and the agent either claims a success that never happened or resends one that already landed.

## Overview

A Solana transaction lands when a leader includes it in a block before its blockhash expires. Three things break that:

1. **Blockhash expiry.** Every transaction carries a recent blockhash and is only valid for about 150 blocks (roughly 60 to 90 seconds). After that the network rejects it permanently. The `lastValidBlockHeight` returned with the blockhash is the exact block height past which the transaction is dead.
2. **Under-pricing.** During congestion a transaction with no priority fee, or one with a bloated compute-unit limit, schedules behind everything else and never gets picked up.
3. **Silent drops.** A leader can drop a transaction from its mempool without any error. The RPC's `confirmTransaction` does not surface this well, which produces the classic "stuck wallet" and "Transaction was not confirmed" symptoms.

This skill is the procedure that sits **above** the RPC and defends against all three. The shape is fixed:

```
build (v0, ALTs if large) -> simulate -> size compute -> set priority fee -> send (maxRetries:0) -> confirm with expiry-aware retry loop
```

This skill owns the orchestration. It deliberately **defers the details** of two sub-decisions to sibling skills you should read when you reach those steps:

- **Choosing the priority-fee price** (the `microLamports` value): see the `priority-fees` skill. This skill tells you to set `setComputeUnitPrice`, not how to pick the number.
- **A faster alternate landing path via a Jito bundle**: see the `jito-bundles` skill. Present it as an alternate, not the default.

Failure decoding (a transaction that landed with an on-chain error) is handed off to the sibling skill `solana-tx-doctor`.

The success criterion is binary: you finish with either a **confirmed signature** or a **decoded terminal failure** (dropped after honest retries, or reverted on-chain). Never report success without a confirmed signature.

## Instructions

Follow this sequence. Each step has an explicit exit condition.

### 1. Build a v0 VersionedTransaction

Assemble the real program instructions (the transfer, swap, or program call). Compile them into a `v0` `VersionedTransaction` from a `TransactionMessage`. Do not add the compute-budget instructions yet: you need to simulate first to learn the real compute cost.

- Use a single recent blockhash from `getLatestBlockhash` for the whole flow, and keep the `lastValidBlockHeight` it returns. The same blockhash drives both the transaction and the expiry tracking in step 6.
- If the account list is large, the serialized transaction can exceed the **1232-byte** packet limit. When that happens, attach **address lookup tables (ALTs)** so account references compress from 32 bytes to 1 byte. See `examples/build-with-alts.ts`.

**Exit when**: you have a compiled v0 `VersionedTransaction` (unsigned) and a `(blockhash, lastValidBlockHeight)` pair. If serialization is already over 1232 bytes, go fix it with ALTs before proceeding.

### 2. Simulate to measure compute

Call `simulateTransaction` on the unsigned transaction with `sigVerify: false` and `replaceRecentBlockhash: true`. Read `value.unitsConsumed`.

```ts
const sim = await connection.simulateTransaction(tx, {
  sigVerify: false,
  replaceRecentBlockhash: true,
});
if (sim.value.err) throw new Error("simulation failed: " + JSON.stringify(sim.value.err));
const unitsConsumed = sim.value.unitsConsumed ?? 0;
```

- `sigVerify: false` lets you simulate before signing.
- `replaceRecentBlockhash: true` substitutes a valid blockhash for the simulation so it does not fail with "blockhash not found", and lets you simulate without burning your real blockhash.
- A simulation error here is a **build bug**, not a congestion problem. Fix the instructions before sending anything.

**Exit when**: simulation succeeds and you have a non-zero `unitsConsumed`.

### 3. Size the compute budget

Set both compute-budget size instructions. Sizing is detailed in `resources/compute-sizing.md`; the short version:

- `ComputeBudgetProgram.setComputeUnitLimit({ units: Math.ceil(unitsConsumed * 1.1) })`. A tight CU limit is not optional polish: it makes the priority fee cheaper (the fee is per CU) and schedules better.
- A SetLoadedAccountsDataSizeLimit instruction sized to the real bytes your accounts load. The default loaded-accounts-data size is **64MB**, which silently adds compute cost. Sizing it down to the real footprint avoids that waste. Setting only `setComputeUnitLimit` is not enough. Note: `@solana/web3.js` v1 has no builder for this instruction, so encode it manually (variant 4 + a u32-LE byte count); see `resources/compute-sizing.md`.

**Exit when**: both size instructions are computed and ready to prepend.

### 4. Set the priority-fee price

Add `ComputeBudgetProgram.setComputeUnitPrice({ microLamports })`.

**Do not pick the `microLamports` number here.** Choosing it correctly (native `getRecentPrioritizationFees` percentile scoped to your writable accounts, or a provider estimate such as Helius `getPriorityFeeEstimate`) is the job of the `priority-fees` skill. Read it for the price decision, then bring back a single `microLamports` value. This skill only requires that the price instruction is present and floored above 0 during congestion.

Prepend the three compute-budget instructions (CU limit, data-size limit, CU price) to the front of the instruction list, then recompile the transaction against your chosen blockhash.

**Exit when**: the transaction carries `setComputeUnitLimit`, `setLoadedAccountsDataSizeLimit`, and `setComputeUnitPrice`, and is compiled against the blockhash from step 1.

### 5. Sign and send with the RPC retry disabled

Sign the transaction, then send the raw bytes with the RPC's own rebroadcast turned **off** so you own the retry loop:

```ts
tx.sign([signer]);
const raw = tx.serialize();
const signature = await connection.sendRawTransaction(raw, {
  skipPreflight: true,
  maxRetries: 0,
});
```

- `skipPreflight: true` because you already simulated in step 2. Preflight at send time just adds latency and can reject on a transient state mismatch.
- `maxRetries: 0` so the RPC does not silently rebroadcast on a schedule you cannot see. The confirm loop in step 6 rebroadcasts deliberately.
- Under congestion, prefer a staked or paid RPC for the send. Validator-staked connections forward transactions to leaders more reliably than a free public endpoint. (Use whichever provider you have; this skill does not endorse one.)
- Keep the signed `raw` bytes in scope. The confirm loop rebroadcasts the **same** signed transaction, never a re-signed one.

**Exit when**: `sendRawTransaction` returns a signature. That signature is a receipt of submission, not of landing. Proceed to confirm.

### 6. Confirm with an expiry-aware retry loop

Do **not** use `confirmTransaction({ signature, blockhash, lastValidBlockHeight })`. It is the source of the "Transaction was not confirmed in N seconds" failures and does not cleanly distinguish dropped from pending. Run the explicit loop instead. The full algorithm and its rationale are in `resources/confirm-loop.md`. The core:

1. Poll `getSignatureStatuses([signature])` every ~2 seconds.
2. If a status appears with `confirmationStatus` of `confirmed` (or `finalized`) and `err === null`: **success**, return the signature.
3. If a status appears with `err !== null`: the transaction **landed but reverted**. Stop. Do not resend. Hand the error to `solana-tx-doctor`.
4. While no status has appeared, every few seconds rebroadcast the same signed `raw` bytes with `sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })`. Leaders drop transactions; rebroadcasting keeps it in front of them.
5. Before each poll, check `getBlockHeight()`. Once `blockHeight > lastValidBlockHeight` and no status ever appeared, the blockhash has expired: the transaction is **DROPPED** and terminal for this blockhash.

On a DROPPED result, the transaction never executed, so it is safe to **rebuild from step 1 with a fresh blockhash** and try again (re-price the fee on each attempt during congestion). On a REVERTED result, the transaction did execute and failed; do not blindly resend.

**Exit when**: you return a confirmed signature, a typed `reverted` result with the on-chain error, or a typed `dropped` result after the blockhash expired.

### 7. (Optional) Alternate landing path: Jito bundle

When the default loop keeps dropping under heavy congestion, or you need atomic ordering, land via a Jito bundle instead of plain `sendRawTransaction`. Add a tip as a `SystemProgram.transfer` to a Jito tip account as the last instruction, submit with `sendBundle`, and poll bundle status. The mechanics, tip sizing, and endpoints live in the `jito-bundles` skill. Reach for this only when the standard send is losing the fee race or you genuinely need atomicity; it is an alternate path, not the default.

## Examples

### Example: land a transfer that keeps getting dropped

When the user asks: "My transaction keeps getting dropped under load, make it actually land."

The agent should:
1. Build the transfer as a v0 `VersionedTransaction` and capture `(blockhash, lastValidBlockHeight)`.
2. Simulate with `sigVerify: false`, `replaceRecentBlockhash: true`; read `unitsConsumed`.
3. Prepend `setComputeUnitLimit(unitsConsumed * 1.1)` and `setLoadedAccountsDataSizeLimit` sized to the accounts.
4. Get `microLamports` from the `priority-fees` skill and prepend `setComputeUnitPrice`.
5. Sign once, send with `skipPreflight: true, maxRetries: 0`.
6. Run the expiry-aware confirm loop: poll `getSignatureStatuses`, rebroadcast the same bytes every few seconds, and give up only when `getBlockHeight` passes `lastValidBlockHeight`.
7. On a dropped result, rebuild with a fresh blockhash and a re-priced fee, then repeat.

The complete runnable function is in `examples/land-transaction.ts`.

### Example: a transaction that is too large to send

When the user asks: "I get 'Transaction too large' / VersionedTransaction over 1232 bytes when I add all my accounts."

The agent should:
1. Recognize the 1232-byte packet limit: too many distinct account keys inflated the message.
2. Create or reuse an address lookup table holding the repeated accounts, and pass it to `compileToV0Message([lookupTable])` so each account reference shrinks to 1 byte.
3. Recompile and confirm the serialized size is under 1232 bytes.
4. Then run the normal simulate, size, price, send, confirm flow above.

The complete runnable example is in `examples/build-with-alts.ts`.

### Example: distinguishing dropped from reverted

When the user asks: "My send 'failed', should I just retry it?"

The agent should:
1. Check `getSignatureStatuses([signature])`. No status and `blockHeight > lastValidBlockHeight` means **DROPPED**: never executed, safe to rebuild and resend.
2. A status with `err !== null` means **REVERTED**: it executed and failed on-chain. Do not resend. Decode the error with `solana-tx-doctor` first, because resending will just revert again.

## Guidelines

- **DO** simulate before every first send and use `unitsConsumed` to set a tight CU limit. Re-simulate when the instruction set or account state changes materially.
- **DO** set all three compute-budget instructions: CU limit, loaded-accounts-data-size limit, and CU price. Skipping the data-size limit silently wastes compute.
- **DO** send with `skipPreflight: true` and `maxRetries: 0`, and own the rebroadcast yourself.
- **DO** rebroadcast the exact same signed bytes during the confirm loop. Re-signing produces a different signature and breaks your tracking.
- **DO** drive expiry off `getBlockHeight()` versus `lastValidBlockHeight`, using the same blockhash you built with.
- **DO** rebuild with a fresh blockhash (and re-priced fee) when a transaction is dropped, since it never executed.
- **DO** prefer a staked or paid RPC for sends during congestion.
- **DON'T** use `confirmTransaction`-by-blockhash as your confirmation mechanism. It causes the "not confirmed" stalls and hides dropped versus pending.
- **DON'T** report success on a returned signature alone. A signature means submitted, not landed.
- **DON'T** blindly resend a transaction that came back with `err !== null`. It landed and reverted; hand it to `solana-tx-doctor`.
- **DON'T** leave the CU limit unset (defaults to 1,400,000 CU, which overpays and schedules worse) or the data-size limit unset (defaults to 64MB).
- **DON'T** re-decide the priority-fee number here; defer to the `priority-fees` skill, and use `jito-bundles` only as an alternate landing path.

## Common Errors

| Symptom / error | Cause | Fix |
|---|---|---|
| "Transaction was not confirmed in N seconds" | Relying on `confirmTransaction`-by-blockhash, which times out instead of resolving dropped vs pending | Replace with the expiry-aware `getSignatureStatuses` + `getBlockHeight` loop in `resources/confirm-loop.md` |
| "Blockhash not found" at send, or transaction silently never lands | The blockhash expired (`blockHeight` passed `lastValidBlockHeight`) before inclusion | Treat as DROPPED, rebuild from step 1 with a fresh `getLatestBlockhash`, re-price the fee, resend |
| Signature returned but no status ever appears | Leader dropped it from the mempool (under-priced or just unlucky) | Rebroadcast the same signed bytes every few seconds inside the confirm loop; bump the priority fee on the next rebuild |
| "exceeded CUs meter" / `ComputeBudgetExceeded` | CU limit set below real usage | Re-simulate, raise the limit, widen headroom (1.1 to 1.2) for state-dependent instructions |
| Fees far higher than expected | Bloated or unset CU limit multiplied by the per-CU price | Set a tight limit from simulation; `fee = ceil(limit * price / 1e6)` |
| "Transaction too large" / serialized message > 1232 bytes | Too many distinct account keys in the message | Move repeated accounts into an address lookup table and `compileToV0Message([lut])`; see `examples/build-with-alts.ts` |
| Status shows `err !== null` after landing | Transaction executed and reverted on-chain | Do NOT resend. Decode with `solana-tx-doctor`, fix the cause, then rebuild |
| RPC seems to resend on its own | `maxRetries` left at its default | Send with `maxRetries: 0` so only your loop rebroadcasts |

## References

- `resources/confirm-loop.md` - the exact expiry-aware confirmation and rebroadcast algorithm, and why `confirmTransaction`-by-blockhash is avoided
- `resources/compute-sizing.md` - sizing `setComputeUnitLimit` and `setLoadedAccountsDataSizeLimit`, and how the priority fee interacts
- `examples/land-transaction.ts` - complete runnable: simulate, size, price, send (maxRetries:0), expiry-aware confirm/rebroadcast loop, typed result
- `examples/build-with-alts.ts` - build a v0 VersionedTransaction with address lookup tables to fit a large instruction set
- `priority-fees` skill - how to choose the `microLamports` price for `setComputeUnitPrice` (deferred from step 4)
- `jito-bundles` skill - the alternate Jito-bundle landing path (deferred from step 7)
- `solana-tx-doctor` skill - decode an on-chain error when a transaction lands with `err !== null`
- [Solana: confirming transactions and durable retry](https://solana.com/docs/core/transactions/confirmation)
- [getSignatureStatuses RPC](https://solana.com/docs/rpc/http/getsignaturestatuses)
- [getLatestBlockhash RPC](https://solana.com/docs/rpc/http/getlatestblockhash)
- [Address Lookup Tables](https://solana.com/docs/advanced/lookup-tables)
- [sendTransaction RPC (maxRetries, skipPreflight)](https://solana.com/docs/rpc/http/sendtransaction)
