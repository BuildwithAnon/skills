# Routing through staked connections (swQoS): the primary landing lever

The single biggest shift in how transactions land on Solana is **where you send them**, not how much you pay. A transaction submitted through a staked connection (swQoS, stake-weighted quality of service) is forwarded to the current leader with priority that tracks the validator's stake. A transaction submitted through a free public RPC competes for the leader's limited non-staked bandwidth and is dropped first under load. Routing is therefore the first thing to get right, ahead of the fee and ahead of every retry trick.

## Why routing beats cranking the fee

The intuition that "land faster = pay more" is mostly wrong in 2026. Leaders schedule by priority fee **after** a packet reaches them. swQoS governs whether the packet reaches them at all. Two findings drive the whole approach:

- The Chorus One latency study found that sending through a staked connection is roughly **3x better at landing a transaction within the next few slots** than sending the same transaction through a non-staked path. The staked path wins the inclusion-latency race.
- In the same measurements, the **size of the priority fee and the size of a Jito tip had little effect on landing latency.** Past a small floor that clears zero-fee spam, paying more did not get the transaction in faster. Fee size mostly governs ordering once you are already in front of the leader, not whether you arrive.

So the priority order is: **route through a staked connection first, set a sane non-zero fee floor second, escalate the fee only across retries third.** Cranking the fee on a non-staked endpoint is the common wrong fix.

## What a staked endpoint is

A staked endpoint forwards your transaction over a connection that carries validator stake weight, so the leader accepts it ahead of the general non-staked pool. Providers expose this in different shapes. Keep your code provider-agnostic: it is still just `sendRawTransaction` (or a provider sendTransaction) against a different URL, plus a couple of query flags.

| Provider | How to route through stake | Notes |
|---|---|---|
| Helius Sender | Dedicated low-latency endpoint; pass `swqos_only=true` to force the staked path only, or leave it dual to also fan out over regular RPC | Sender is send-only; confirm against a normal RPC |
| Triton (Jet) | Stake-weighted send endpoint | Provider-specific URL; same `sendRawTransaction` shape |
| QuickNode stake pool | Stake-backed add-on on the send endpoint | Enable on the endpoint, then send normally |

This skill does not endorse one provider. The contract is the same: you send the **same signed bytes** to a staked send URL, and you confirm against a normal (possibly different) RPC.

## Send-only vs confirm-capable

Several staked send endpoints (Helius Sender is the clearest example) are **send-only**: they accept transactions fast but do not answer `getSignatureStatuses`, `getBlockHeight`, or subscriptions. Split the two roles:

- **Send / rebroadcast** through the staked endpoint (lowest inclusion latency).
- **Confirm** (poll statuses, watch block height, subscribe) through a normal full RPC.

```ts
// Two connections: one to SEND through stake, one to CONFIRM.
const sender = new Connection(STAKED_SEND_URL, { commitment: "confirmed" });
const rpc = new Connection(FULL_RPC_URL, { commitment: "confirmed" });

// send + rebroadcast the SAME bytes through the staked path
await sender.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
// confirm through the full RPC
const { value } = await rpc.getSignatureStatuses([signature]);
```

If your staked endpoint is also a full RPC, one connection is fine. The split is only required when the send endpoint is send-only.

## Helius Sender specifics

- Endpoint is send-only and tuned for latency.
- `swqos_only=true` forces the staked-only path. Leaving it off lets the provider also fan the transaction out over regular RPC, which trades a little latency for broader propagation. Under heavy congestion, `swqos_only=true` is usually the better landing bet because it commits fully to the stake path.
- Sender requires a minimum priority fee and (typically) a Jito tip alongside the transaction. Treat that as the fee floor, not as the latency lever: keep it at the documented minimum unless ordering against other transactions actually matters.

## Routing as step zero of every send

Fold routing into the procedure as a first-class decision, not an afterthought:

1. Pick a **staked send endpoint** for `sendRawTransaction` and every rebroadcast.
2. Pick a **confirm RPC** (the same endpoint if it answers status queries, otherwise a separate full RPC).
3. Build, simulate, size, price (sane floor), sign, then send through the staked endpoint.
4. Confirm against the confirm RPC. Rebroadcast through the staked endpoint.
5. Escalate the fee only across retries, and only after routing is already staked.

## Checklist

- [ ] Send and rebroadcast through a staked endpoint (Helius Sender / Triton Jet / QuickNode stake pool).
- [ ] Confirm against a full RPC (separate connection if the send endpoint is send-only).
- [ ] Treat the fee and tip as floors, not latency levers; staked routing carries the latency win.
- [ ] Keep it provider-agnostic: same signed bytes, different send URL.
