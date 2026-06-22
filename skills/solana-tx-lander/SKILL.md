---
name: solana-tx-lander
description: The RPC-agnostic procedure to reliably LAND a Solana transaction under congestion. Use when a transaction needs to land, confirm, and survive retry, or when a send is dropping, timing out, or stuck pending. Covers routing through a staked (swQoS) path first, then the full build, simulate, size compute, set priority fee, send, and confirm-with-retry loop above any RPC. Keywords: land transaction, routing, swQoS, staked connection, stake-weighted, Helius Sender, Jito bundle, confirm, retry, compute unit limit, blockhash expiry, durable nonce, transaction not confirmed, dropped transaction, lastValidBlockHeight, getSignatureStatuses, signatureSubscribe, rebroadcast, VersionedTransaction, address lookup tables, transaction too large.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Land a Solana Transaction Under Congestion

Get a Solana transaction confirmed when the network is busy by owning every step from build to confirmation, never trusting an RPC default to do it for you. Sending and hoping is the single most common agent failure mode on Solana: the transaction goes out, the RPC reports nothing useful, and the agent either claims a success that never happened or resends one that already landed.

## Overview

A Solana transaction lands when a leader includes it in a block before its blockhash expires. Four things break that:

1. **Wrong routing.** Where you submit decides whether the packet even reaches the leader. A transaction sent through a free public RPC competes for the leader's scarce non-staked bandwidth and is dropped first under load. A transaction sent through a staked (swQoS, stake-weighted quality of service) connection is forwarded with priority. The Chorus One 2026 latency study found staked routing lands within the next few slots roughly **3x more reliably** than a non-staked path, while the size of the priority fee and the size of a Jito tip had little effect on latency on their own. Routing is the first lever, ahead of the fee.
2. **Blockhash expiry.** Every transaction carries a recent blockhash and is only valid for about 150 blocks (roughly 60 to 90 seconds). After that the network rejects it permanently. The `lastValidBlockHeight` returned with the blockhash is the exact block height past which the transaction is dead.
3. **Under-pricing.** During congestion a transaction with no priority fee, or one with a bloated compute-unit limit, schedules behind everything else and never gets picked up. Note the fee mostly governs ordering once you are already in front of the leader, so escalate it across retries rather than treating a single big fee as the fix.
4. **Silent drops.** A leader can drop a transaction from its mempool without any error. The RPC's `confirmTransaction` does not surface this well, which produces the classic "stuck wallet" and "Transaction was not confirmed" symptoms.

This skill is the procedure that sits **above** the RPC and defends against all four. The shape is fixed:

```
route (staked send) -> build (v0, ALTs if large) -> simulate -> size compute -> set priority fee -> sign on a fresh blockhash -> send (maxRetries:0) -> confirm with expiry-aware retry loop (raced subscription + poll backstop)
```

The single biggest change since the early priority-fee era is that landing is a **routing problem first, a fee problem second**. The full 2026 strategy (routing, the real Jito path, raced confirmation, fresh blockhash, fee escalation, RPC-health cross-check, durable nonce) is laid out in `resources/landing-2026.md`. The detail of the staked send is in `resources/routing-staked-connections.md`.

This skill owns the orchestration. It deliberately **defers the details** of two sub-decisions to sibling skills you should read when you reach those steps:

- **Choosing the priority-fee price** (the `microLamports` value): see the `priority-fees` skill. This skill tells you to set `setComputeUnitPrice`, not how to pick the number.
- **A faster alternate landing path via a Jito bundle**: see the `jito-bundles` skill, and `resources/jito-path.md` for the real mechanics (random tip account, live tip floor, `sendBundle`/`getBundleStatuses`, and the Jito-leader-slot caveat). Present it as an alternate, not the default.

Failure decoding (a transaction that landed with an on-chain error) is handed off to the sibling skill `solana-tx-doctor`.

The success criterion is binary: you finish with either a **confirmed signature** or a **decoded terminal failure** (dropped after honest retries, or reverted on-chain). Never report success without a confirmed signature.

## Instructions

Follow this sequence. Each step has an explicit exit condition.

### 0. Route first: pick a staked (swQoS) send path before touching the fee

Decide **where** the transaction is submitted before you decide anything about the fee. This is the highest-leverage step and the one most agents skip. Send and rebroadcast through a stake-weighted (swQoS) endpoint so your transaction reaches the current leader on a prioritized connection instead of competing for the leader's non-staked bandwidth, which is what gets dropped first under load.

- Use a normal full RPC for reads, simulation, and confirmation; use a **staked send endpoint** for `sendRawTransaction` and every rebroadcast. Examples: Helius Sender (pass `swqos_only=true` to force the staked-only path), Triton Jet, a QuickNode stake pool. Stay provider-agnostic: it is the **same signed bytes** sent to a different send URL.
- Several staked endpoints (Helius Sender is the clearest) are **send-only** and do not answer `getSignatureStatuses` or `getBlockHeight`. When that is the case, split the roles: one connection to send through stake, a separate full RPC to confirm.
- Treat the priority fee and any Jito tip as **floors that clear spam, not latency levers.** Per the Chorus One study, routing wins the inclusion-latency race; fee size does not. Crank the fee only across retries (step 6), and only after routing is already staked.

The full rationale, the provider table, and the send-vs-confirm split are in `resources/routing-staked-connections.md` (and summarized in `resources/landing-2026.md`).

**Exit when**: you have a staked send connection chosen for `sendRawTransaction` and a confirm RPC chosen for status queries (they may be the same connection if your endpoint answers both).

### 1. Build a v0 VersionedTransaction

Assemble the real program instructions (the transfer, swap, or program call). Compile them into a `v0` `VersionedTransaction` from a `TransactionMessage`. Do not add the compute-budget instructions yet: you need to simulate first to learn the real compute cost.

- Use a recent blockhash from `getLatestBlockhash` for simulation and sizing, and keep the `lastValidBlockHeight` it returns. The same blockhash drives both the transaction and the expiry tracking in step 6. **Re-fetch the blockhash immediately before the final sign** (step 5) so the full ~150-block validity window is still ahead of you when rebroadcasting begins; a blockhash fetched at the top of a slow build can already be partway through its lifetime by send time.
- If the account list is large, the serialized transaction can exceed the **1232-byte** packet limit. When that happens, attach **address lookup tables (ALTs)** so account references compress from 32 bytes to 1 byte. See `examples/build-with-alts.ts`.
- **Durable-nonce alternate (for non-time-sensitive sends).** When timing does not matter (offline signing, queued or batched sends), skip the recent-blockhash expiry game entirely: use a durable nonce. Make the **first** instruction `SystemProgram.nonceAdvance` and build the message with the stored nonce as `recentBlockhash` instead of a fresh blockhash. The transaction then stays valid until the nonce account advances, so there is no expiry to lose to. See `resources/landing-2026.md` for when to prefer this over the rebroadcast loop.

**Exit when**: you have a compiled v0 `VersionedTransaction` (unsigned) and a `(blockhash, lastValidBlockHeight)` pair (or a nonce + nonceAdvance for the durable-nonce path). If serialization is already over 1232 bytes, go fix it with ALTs before proceeding.

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
- A SetLoadedAccountsDataSizeLimit instruction sized to the real bytes your accounts load. Loaded-accounts data costs roughly **8 CU per 32KB**, and the default cap is **64MB**, which silently adds about **16,000 CU** to your effective compute accounting. Sizing it down to the real footprint avoids that waste, so this is a deliberate landing lever, not a magic constant. Setting only `setComputeUnitLimit` is not enough. **API note:** `@solana/web3.js` **v1** has no builder for this instruction, so encode it manually (Compute Budget program, discriminator 4, a u32-LE byte count); see `resources/compute-sizing.md`. **Kit/v2** code should instead use `getSetLoadedAccountsDataSizeLimitInstruction` from `@solana-program/compute-budget`. The manual-encoding technique in the examples is the v1-specific path.

**Exit when**: both size instructions are computed and ready to prepend.

### 4. Set the priority-fee price

Add `ComputeBudgetProgram.setComputeUnitPrice({ microLamports })`.

**Do not pick the `microLamports` number here.** Choosing it correctly (native `getRecentPrioritizationFees` percentile scoped to your writable accounts, or a provider estimate such as Helius `getPriorityFeeEstimate`) is the job of the `priority-fees` skill. Read it for the price decision, then bring back a single `microLamports` value. This skill only requires that the price instruction is present and floored above 0 during congestion.

**Escalate, do not just crank.** On the first attempt, a sane percentile (a fee floor) is enough, because most drops are routing problems, not fee problems (step 0). When a transaction comes back DROPPED and you rebuild (step 6), raise the fee **percentile** for the next attempt and **re-simulate**, rather than resending the same fixed price. A monotonically escalating percentile across retries is the right shape; a single huge fixed fee is the wrong fix.

Prepend the three compute-budget instructions (CU limit, data-size limit, CU price) to the front of the instruction list, then recompile the transaction against your chosen blockhash.

**Exit when**: the transaction carries `setComputeUnitLimit`, `setLoadedAccountsDataSizeLimit`, and `setComputeUnitPrice`, and is compiled against the blockhash from step 1.

### 5. Sign on a fresh blockhash and send with the RPC retry disabled

Re-fetch `getLatestBlockhash` right now and compile the final transaction against it, so the version you broadcast has its full validity window ahead of it (the blockhash from step 1 may have aged during simulate/size/price). Then sign the transaction and send the raw bytes with the RPC's own rebroadcast turned **off** so you own the retry loop:

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
- **Send through the staked endpoint chosen in step 0.** Validator-staked (swQoS) connections forward transactions to leaders far more reliably than a free public endpoint, and this is the single largest landing lever. If that endpoint is send-only, confirm against your separate full RPC in step 6. (Use whichever provider you have; this skill does not endorse one.)
- Keep the signed `raw` bytes in scope. The confirm loop rebroadcasts the **same** signed transaction, never a re-signed one.

**Exit when**: `sendRawTransaction` returns a signature. That signature is a receipt of submission, not of landing. Proceed to confirm.

### 6. Confirm with an expiry-aware retry loop

Do **not** use `confirmTransaction({ signature, blockhash, lastValidBlockHeight })`. It is the source of the "Transaction was not confirmed in N seconds" failures and does not cleanly distinguish dropped from pending (Solana issue 23949 documents why it is broken). Run the explicit loop instead. The full algorithm and its rationale are in `resources/confirm-loop.md`. The core:

1. **Race a WebSocket `signatureSubscribe` against the poll loop.** Subscribe to the signature for the fastest possible notification, and run `getSignatureStatuses([signature])` polling every ~2 seconds as a **backstop** in case the subscription drops or stalls. Whichever resolves first wins; poll-only also works if you have no socket. This is lower latency and fewer RPC calls than poll-only.
2. If a status appears with `confirmationStatus` of `confirmed` (or `finalized`) and `err === null`: **success** (`Landed`), return the signature.
3. If a status appears with `err !== null`: the transaction **landed but reverted** (`Reverted`, `meta.err` set). Stop. Do not resend. Hand the error to `solana-tx-doctor`.
4. While no status has appeared, every few seconds rebroadcast the same signed `raw` bytes through the **staked endpoint** with `sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 })`. Leaders drop transactions; rebroadcasting keeps it in front of them.
5. Before each poll, check `getBlockHeight()`. **RPC-health cross-check:** a lagging node behind on slots can report a false "not found", so prefer the node reporting the highest slot and do not trust a single possibly-stale RPC for the expiry decision.
6. **Guard the false negative before declaring a drop.** A transaction can land in the very slot the blockhash is "exceeded". Once `blockHeight > lastValidBlockHeight` and no status has appeared, do **one final `getSignatureStatuses` check**; only if that is still empty do you conclude **DROPPED**. (The `BlockheightExceeded-but-landed` case is exactly the false negative this guard catches.)

Emit **typed outcomes**: `Landed` (confirmed, `err === null`), `Reverted` (landed with `meta.err`), `Dropped` (never included, blockhash expired), `Timeout` (wall-clock guard tripped without a status), and treat `BlockheightExceeded-but-landed` as `Landed` thanks to the final-check guard, never as a drop.

On a DROPPED (or Timeout) result, the transaction never executed, so it is safe to **rebuild from step 1 with a fresh blockhash** and try again (escalate the fee percentile and re-simulate on each attempt during congestion, per step 4). On a REVERTED result, the transaction did execute and failed; do not blindly resend.

**Exit when**: you return one of the typed outcomes: `Landed` (confirmed signature), `Reverted` (with the on-chain error), or `Dropped`/`Timeout` after the expiry guard cleared.

### 7. (Optional) Alternate landing path: Jito bundle

When the default loop keeps dropping under heavy congestion, or you need atomic ordering, land via a Jito bundle in **parallel** with (not instead of) the staked send. The real mechanics are in `resources/jito-path.md`:

- **Tip account:** pick one of the **8** Jito tip accounts **at random** per bundle (sending every tip to one account creates contention). The tip is a `SystemProgram.transfer` to the chosen account, commonly the last instruction of the last transaction in the bundle.
- **Tip floor:** read it live, do not hardcode. `GET https://bundles.jito.wtf/api/v1/bundles/tip_floor` and size from the **75th percentile**. Like the priority fee, a bigger tip mostly improves ordering, not arrival.
- **Submit and poll:** `sendBundle` (returns a bundle id) then poll `getBundleStatuses`.
- **The caveat that decides whether bundles help:** bundles only land in slots led by a **Jito-Solana** validator. A non-Jito leader ignores them entirely, so a bundle is a **parallel** route, not a guaranteed one. Keep the normal staked send running alongside as the fallback, and confirm the real outcome on the signature (step 6), not on "bundle submitted".

Reach for this only when the standard staked send is losing under extreme load or you genuinely need atomicity; it is an alternate path, not the default. The endpoints and full code live in `resources/jito-path.md` and the `jito-bundles` skill.

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

- **DO** route the send through a staked (swQoS) endpoint first. It is the largest landing lever, ahead of the fee; confirm against a normal full RPC, splitting connections if the send endpoint is send-only.
- **DO** simulate before every first send and use `unitsConsumed` to set a tight CU limit. Re-simulate when the instruction set or account state changes materially.
- **DO** set all three compute-budget instructions: CU limit, loaded-accounts-data-size limit, and CU price. Skipping the data-size limit silently wastes compute (~16,000 CU from the 64MB default at ~8 CU per 32KB).
- **DO** send with `skipPreflight: true` and `maxRetries: 0`, and own the rebroadcast yourself.
- **DO** re-fetch a fresh blockhash immediately before the final sign so the full validity window is ahead of the broadcast.
- **DO** rebroadcast the exact same signed bytes during the confirm loop. Re-signing produces a different signature and breaks your tracking.
- **DO** race a WebSocket `signatureSubscribe` against the poll loop, with the poll as the backstop.
- **DO** drive expiry off `getBlockHeight()` versus `lastValidBlockHeight`, using the same blockhash you built with, and do one final `getSignatureStatuses` check before declaring DROPPED (the block-height-exceeded-but-landed guard).
- **DO** cross-check RPC health: prefer the node reporting the highest slot, since a lagging node can report a false "not found".
- **DO** rebuild with a fresh blockhash and an escalated fee percentile (re-simulate) when a transaction is dropped, since it never executed.
- **DO** consider a durable nonce (first instruction `nonceAdvance`) for non-time-sensitive or offline-signed sends, which removes blockhash expiry entirely.
- **DON'T** use `confirmTransaction`-by-blockhash as your confirmation mechanism. It causes the "not confirmed" stalls and hides dropped versus pending.
- **DON'T** report success on a returned signature alone. A signature means submitted, not landed.
- **DON'T** treat a single big priority fee or Jito tip as the fix; routing wins inclusion latency, the fee mostly governs ordering. Escalate the fee across retries instead.
- **DON'T** blindly resend a transaction that came back with `err !== null`. It landed and reverted; hand it to `solana-tx-doctor`.
- **DON'T** leave the CU limit unset (defaults to 1,400,000 CU, which overpays and schedules worse) or the data-size limit unset (defaults to 64MB).
- **DON'T** assume a Jito bundle will land: it only lands in Jito-Solana leader slots, so run it parallel to the staked send, not instead of it.
- **DON'T** re-decide the priority-fee number here; defer to the `priority-fees` skill, and use `jito-bundles` only as an alternate landing path.

## Common Errors

| Symptom / error | Cause | Fix |
|---|---|---|
| "Transaction was not confirmed in N seconds" | Relying on `confirmTransaction`-by-blockhash, which times out instead of resolving dropped vs pending | Replace with the expiry-aware `getSignatureStatuses` + `getBlockHeight` loop in `resources/confirm-loop.md` |
| "Blockhash not found" at send, or transaction silently never lands | The blockhash expired (`blockHeight` passed `lastValidBlockHeight`) before inclusion | Treat as DROPPED, rebuild from step 1 with a fresh `getLatestBlockhash`, re-price the fee, resend |
| Signature returned but no status ever appears | Leader dropped it from the mempool, often because the send went through a non-staked public RPC | Route the send (and rebroadcast) through a staked (swQoS) endpoint; rebroadcast the same signed bytes inside the confirm loop; escalate the fee percentile on the next rebuild |
| Declared DROPPED but the transaction actually landed | Block height "exceeded" in the same slot the transaction landed, or a lagging RPC reported a false "not found" | Do one final `getSignatureStatuses` check (highest-slot node) before concluding DROPPED; treat block-height-exceeded-but-landed as Landed |
| "exceeded CUs meter" / `ComputeBudgetExceeded` | CU limit set below real usage | Re-simulate, raise the limit, widen headroom (1.1 to 1.2) for state-dependent instructions |
| Fees far higher than expected | Bloated or unset CU limit multiplied by the per-CU price | Set a tight limit from simulation; `fee = ceil(limit * price / 1e6)` |
| "Transaction too large" / serialized message > 1232 bytes | Too many distinct account keys in the message | Move repeated accounts into an address lookup table and `compileToV0Message([lut])`; see `examples/build-with-alts.ts` |
| Status shows `err !== null` after landing | Transaction executed and reverted on-chain | Do NOT resend. Decode with `solana-tx-doctor`, fix the cause, then rebuild |
| RPC seems to resend on its own | `maxRetries` left at its default | Send with `maxRetries: 0` so only your loop rebroadcasts |

## References

- `resources/landing-2026.md` - the 2026 landing strategy: routing first, real Jito path, raced confirmation, fresh blockhash, fee escalation, RPC-health cross-check, durable nonce, and the v1-vs-kit data-size note with CU rationale
- `resources/routing-staked-connections.md` - the staked (swQoS) send path: why routing beats cranking the fee, the provider table, and the send-vs-confirm split
- `resources/jito-path.md` - the real Jito-bundle mechanics: random tip account, live tip floor, `sendBundle`/`getBundleStatuses`, and the Jito-leader-slot caveat
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
