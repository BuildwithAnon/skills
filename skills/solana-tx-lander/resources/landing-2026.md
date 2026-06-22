# Landing strategy in 2026: routing first, then fees

The biggest shift since the early priority-fee era: under congestion, HOW you submit (routing) matters more for inclusion latency than how high you set the fee. Chorus One's 2026 latency study found staked-connection routing (swQoS) lands transactions in the next few slots roughly 3x more reliably than relying on fee size, and that priority-fee size and Jito-tip size have little effect on latency on their own. So treat landing as a routing problem first.

## 1. Route through a staked (swQoS) path first
Send through a stake-weighted endpoint so your transaction reaches the leader through a prioritized connection:
- Helius Sender with the swQoS option.
- Triton Jet.
- QuickNode stake-weighted endpoint.
Keep this RPC-agnostic: the skill works with any staked provider. Use a normal RPC for reads and simulation, and a staked endpoint for the send.

## 2. Jito bundle as a real alternate path (not a name-drop)
When you need atomicity or an extra landing route:
- Pick one of the 8 tip accounts at random per send.
- Size the tip from the live floor: GET https://bundles.jito.wtf/api/v1/bundles/tip_floor and use the 75th percentile.
- Submit with sendBundle, then poll getBundleStatuses.
- Critical caveat: bundles only land in Jito-Solana leader slots. A non-Jito validator client ignores them, so a bundle is not a guaranteed path, it is a parallel one.

## 3. Confirm with a raced subscription, not the broken blockhash confirm
- Race a WebSocket signatureSubscribe against the getSignatureStatuses poll loop, with the poll as a backstop if the subscription drops. Lower latency and fewer RPC calls than poll-only.
- Bind the wait to lastValidBlockHeight, not confirmTransaction-by-blockhash (which is the approach Solana issue 23949 calls broken).
- Guard the false negative: a transaction can land even after the block height is "exceeded". Before declaring a drop, do a final getSignatureStatuses check, and only then conclude Dropped.
- Emit typed outcomes: Landed, Reverted (landed with meta.err), Dropped (never included), Timeout, BlockheightExceeded-but-landed.

## 4. Fresh blockhash immediately before the final sign
Re-fetch getLatestBlockhash right before signing the version you will broadcast, so the full validity window is ahead of you when rebroadcasting begins.

## 5. Escalate, do not just crank
Across retry attempts, escalate the priority-fee percentile and re-simulate, rather than sending the same fixed price repeatedly. Note that most drops are not fee-related, so raising the fee alone is often the wrong fix; routing (section 1) usually helps more.

## 6. RPC-health cross-check
When confirming, prefer the node reporting the highest slot and detect a lagging node (a node behind on slots can report a false "not found"). Do not trust a single possibly-stale RPC.

## 7. Durable nonce alternate for non-time-sensitive sends
For transactions that do not need to be timely (offline signing, queued sends), use a durable nonce: the first instruction is nonceAdvance and the transaction uses the stored nonce instead of a recent blockhash. This removes blockhash expiry entirely, so the transaction stays valid until the nonce advances.

## 8. Compute sizing note (data size limit)
- @solana/web3.js v1 has NO builder for SetLoadedAccountsDataSizeLimit, so encode the instruction manually (Compute Budget program, discriminator 4, a u32 little-endian byte count). This is the v1-specific technique in our example.
- Kit-era code should use @solana-program/compute-budget getSetLoadedAccountsDataSizeLimitInstruction instead.
- Why it matters: loaded-accounts data costs roughly 8 CU per 32KB, and the default cap is 64MB which silently adds about 16,000 CU. Setting a tight, real value lowers your CU bill and improves scheduling, so it is a deliberate landing lever, not a magic constant.
