# The Jito bundle alternate path (real mechanics)

A Jito bundle is an alternate way to land one or more transactions atomically and, when you need it, with guaranteed ordering. It is **not** the default path. Reach for it when you need atomic ordering (for example a multi-leg arbitrage that must all execute or none), or when the standard staked send keeps losing under extreme load. For a single ordinary transaction, staked routing plus the confirm loop is simpler and lands just as well.

## The one caveat that decides whether bundles help you

**Bundles only land in slots led by a Jito-Solana validator.** A leader running a non-Jito client ignores bundles entirely. Roughly speaking a large share of slots are Jito-led, but not all of them, so a bundle can sit unaccepted for several slots until a Jito leader rotates in. If your transaction is time-critical to the next slot and the upcoming leader is non-Jito, the bundle does nothing for you. Plan for this: keep the normal staked-send path as a parallel or fallback route, and do not treat "bundle submitted" as "transaction will land."

## Tip accounts: pick one of eight at random

Jito has **8** tip accounts. Sending all tips to one account creates contention, so pick one **at random per bundle**. The tip is a `SystemProgram.transfer` to the chosen tip account, included as an instruction (commonly the last instruction of the last transaction in the bundle).

```ts
import { PublicKey, SystemProgram } from "@solana/web3.js";

const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghULbWcw",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function randomTipAccount(): PublicKey {
  const i = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return new PublicKey(JITO_TIP_ACCOUNTS[i]);
}

function tipInstruction(from: PublicKey, tipLamports: number) {
  return SystemProgram.transfer({
    fromPubkey: from,
    toPubkey: randomTipAccount(),
    lamports: tipLamports,
  });
}
```

## Tip floor: read it live, do not hardcode

Tips are a market. Hardcoding a tip either overpays or gets you ignored. Read the live floor from the Jito tip-floor endpoint and pick a percentile (the 75th percentile is a reasonable land-soon target). Note the same latency caveat as the priority fee: a bigger tip mostly improves ordering, not whether you arrive, so size it to the floor rather than chasing it upward.

```ts
// Live tip floor, in SOL, from Jito. Convert the chosen percentile to lamports.
async function jitoTipLamports(percentile: "p50" | "p75" | "p95" = "p75"): Promise<number> {
  const res = await fetch("https://bundles.jito.wtf/api/v1/bundles/tip_floor");
  const rows = (await res.json()) as Array<Record<string, number>>;
  const row = rows[0] ?? {};
  // Field names are like landed_tips_25th_percentile, _50th_, _75th_, _95th_ (SOL).
  const key =
    percentile === "p50"
      ? "landed_tips_50th_percentile"
      : percentile === "p95"
        ? "landed_tips_95th_percentile"
        : "landed_tips_75th_percentile";
  const tipSol = row[key] ?? 0.0001; // small fallback if the field is missing
  return Math.ceil(tipSol * 1_000_000_000); // SOL -> lamports
}
```

## Submit and poll: sendBundle then getBundleStatuses

Bundles go to the Jito Block Engine, not to a normal RPC. The flow is `sendBundle` (returns a bundle id) then `getBundleStatuses` (poll until landed or dropped). Each transaction in the bundle is base58 (or base64, per the endpoint) of the signed bytes.

```ts
const JITO_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";

async function sendBundle(signedTxsBase58: string[]): Promise<string> {
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [signedTxsBase58],
    }),
  });
  const json = await res.json();
  if (json.error) throw new Error("sendBundle failed: " + JSON.stringify(json.error));
  return json.result as string; // bundle id
}

async function getBundleStatuses(bundleId: string): Promise<unknown> {
  const res = await fetch(JITO_BLOCK_ENGINE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getBundleStatuses",
      params: [[bundleId]],
    }),
  });
  const json = await res.json();
  return json.result; // { value: [{ bundle_id, confirmation_status, transactions, slot, err }] }
}
```

## How to use it as an alternate, not a replacement

1. Build, simulate, and size the transaction normally (the bundle still carries a real transaction).
2. Append the tip instruction (random account, live floor) to the last transaction.
3. Submit with `sendBundle`, then poll `getBundleStatuses`.
4. **Because bundles only land in Jito leader slots, keep the normal staked send running in parallel as the fallback.** If the bundle has not landed after a handful of slots (the next leader was non-Jito), the staked send is what actually lands the transaction.
5. Confirm the final outcome the same way as the default path: `getSignatureStatuses` on the signature, bounded by blockhash expiry.

## Checklist

- [ ] Pick one of the 8 tip accounts at random per bundle.
- [ ] Read the live tip floor from bundles.jito.wtf and use the 75th percentile.
- [ ] sendBundle then poll getBundleStatuses for the bundle id.
- [ ] Remember bundles land only in Jito leader slots; run the staked send as a parallel fallback.
- [ ] Confirm the real outcome on the signature, not on "bundle submitted".
