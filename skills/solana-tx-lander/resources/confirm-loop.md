# The expiry-aware confirmation and rebroadcast loop

This is the heart of landing a transaction reliably. Sending a transaction returns a signature, which only means the RPC accepted the bytes for submission. It says nothing about whether a leader included the transaction in a block. To know the real outcome you must poll, rebroadcast, and bound the wait by the blockhash lifetime.

## Why not `confirmTransaction`-by-blockhash

The convenient one-liner looks like this:

```ts
// AVOID this as your confirmation mechanism.
await connection.confirmTransaction(
  { signature, blockhash, lastValidBlockHeight },
  "confirmed"
);
```

It is avoided here for concrete reasons:

1. **It does not rebroadcast.** It only waits. If the leader dropped your transaction (common under congestion), waiting alone never recovers it. You sit until expiry and then get an error.
2. **It collapses distinct outcomes into a timeout.** "Dropped, never executed" and "still pending" both surface as the same "Transaction was not confirmed in N seconds" message. You cannot tell whether it is safe to resend.
3. **It relies on a WebSocket subscription** for the signature plus a blockheight watch, and a flaky or rate-limited socket turns into a hang. This is the classic "stuck wallet" behavior.

The explicit loop fixes all three: it actively rebroadcasts, it reads the real signature status, and it has a deterministic terminal condition (blockhash expiry) that cleanly labels the result DROPPED.

## The two signals

- **`getSignatureStatuses([signature])`** tells you whether the transaction landed and how. The response `value[0]` is `null` until it lands. Once it lands you get `{ confirmationStatus, err, slot, confirmations }`.
  - `err === null` and `confirmationStatus` is `confirmed` or `finalized`: **landed and succeeded**.
  - `err !== null`: **landed and reverted** (executed on-chain, failed). Do not resend.
- **`getBlockHeight()` versus `lastValidBlockHeight`** tells you whether the transaction can still land. A blockhash is valid for about 150 blocks. The `lastValidBlockHeight` returned alongside the blockhash by `getLatestBlockhash` is the exact height past which the transaction is permanently invalid. Once `getBlockHeight() > lastValidBlockHeight` and no status appeared, the transaction is **DROPPED**.

Use the **same** blockhash and `lastValidBlockHeight` you built and signed with. Tracking expiry against a different blockhash is meaningless.

## The algorithm

```
INPUT: signedRawBytes, signature, blockhash, lastValidBlockHeight
loop:
  status = getSignatureStatuses([signature]).value[0]
  if status != null:
     if status.err != null:        return REVERTED(status.err)      # landed, failed
     if status.confirmationStatus in {confirmed, finalized}:
                                    return CONFIRMED(signature)      # success
  height = getBlockHeight()
  if height > lastValidBlockHeight: return DROPPED                   # expired, never executed
  every ~few seconds:
     sendRawTransaction(signedRawBytes, { skipPreflight: true, maxRetries: 0 })  # rebroadcast SAME bytes
  sleep ~2 seconds
```

Key invariants:

- **Rebroadcast the exact same signed bytes.** Re-signing produces a new signature and you lose the ability to track the original. The transaction is idempotent: if it already landed, a duplicate broadcast is a harmless no-op (the network rejects the already-processed signature), so rebroadcasting is always safe.
- **Poll status before checking expiry.** A transaction can land in the same slot the blockhash expires; checking status first avoids a false DROPPED.
- **Separate the poll cadence from the rebroadcast cadence.** Poll roughly every 2 seconds; rebroadcast every few seconds (for example every 2 to 4 polls) to avoid hammering the RPC while still keeping the transaction in front of leaders.
- **DROPPED is safe to retry.** Because the transaction never executed, rebuild from scratch with a fresh `getLatestBlockhash` (and a re-priced fee under congestion) and run the whole flow again.
- **REVERTED is not safe to blindly retry.** It executed and failed. Resending the same transaction reverts again. Hand the `err` to the `solana-tx-doctor` skill to decode it, fix the cause, then rebuild.

## Choosing commitment

- Use `confirmed` for the loop's success threshold in most cases. It is fast and durable enough that a reorg dropping it is very unlikely.
- Use `finalized` only when the action is high-value and you must be certain it cannot be rolled back. It is slower (an extra ~13 seconds or so) but maximally safe.
- Be consistent: build the connection, the blockhash, and the status check at the commitment you intend to treat as final.

## Bounding the total wait

The loop terminates naturally at blockhash expiry (about 60 to 90 seconds). You may still want a wall-clock guard so a misbehaving RPC that never advances `getBlockHeight()` cannot hang you forever. Cap total time at, say, 90 seconds and treat a timeout as DROPPED (rebuild and retry), since if it had landed a status would have appeared.

## Summary table

| Observation | Meaning | Action |
|---|---|---|
| status `null`, height <= lastValid | still pending | keep polling, rebroadcast same bytes |
| status `err === null`, confirmed/finalized | landed and succeeded | return the confirmed signature |
| status `err !== null` | landed and reverted | stop, decode with solana-tx-doctor, do not resend |
| status `null`, height > lastValid | blockhash expired, never executed | DROPPED: rebuild with fresh blockhash, re-price, retry |
