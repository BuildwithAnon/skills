---
name: solana-pay
description: Build Solana Pay payment requests and verify completed payments with the @solana/pay SDK. Use when a user wants to accept SOL or SPL token payments, generate a payment request URL or QR code, build a point-of-sale or checkout flow, create a transfer request (recipient + amount) or a transaction request (a server that returns a partially signed transaction for arbitrary instructions), or confirm a payment landed on chain before fulfilling an order. Keywords: Solana Pay, payment request, QR code, transfer request, transaction request, encodeURL, parseURL, createQR, findReference, validateTransfer, verify payment, point of sale, checkout, accept SOL, accept USDC.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Pay

Build and verify Solana Pay flows: encode a payment as a `solana:` URL or QR code, then confirm on chain that the exact payment arrived before you fulfill anything. Covers both request types in the spec, the unique-reference pattern that lets a merchant tell two payments apart, and the two-step verification (`findReference` then `validateTransfer`) that guards against wrong-amount or wrong-recipient spoofing.

## Overview

Solana Pay is a URL spec, not a hosted service. A merchant encodes what it wants paid into a `solana:` URL, shows it to the payer (usually as a QR code), the payer's wallet builds and submits the transaction, and the merchant later finds that transaction on chain and validates it matches the request. The whole flow is local code plus RPC calls; there is no Solana Pay server or API key.

There are two request shapes, and choosing the wrong one is the most common modeling mistake:

1. **Transfer request** (`solana:<recipient>?amount=...`): a plain SOL or SPL token transfer. The amount, token, and recipient are baked into the URL. The wallet constructs the transfer itself. Use this for "charge X tokens to this address."
2. **Transaction request** (`solana:https://merchant/api/pay`): the URL is an HTTPS link to your endpoint. The wallet `GET`s it for a label and icon, then `POST`s the payer's account so your server can build and partially sign an arbitrary transaction. Use this when the payment is more than a transfer (program calls, multiple instructions, dynamic pricing, memos computed server-side).

The verification half is the same for both and is the part agents most often skip. A payment is not done because a QR was scanned; it is done when you have located the on-chain transaction by its **reference** and validated that the recipient, amount, token, and reference all match what you asked for. Skipping `validateTransfer` lets a payer (or a man in the middle) present a transaction that paid a different amount or a different recipient.

Use this skill when the user wants to accept payments on Solana, generate a payment QR or link, build a checkout / point-of-sale flow, or confirm a specific payment cleared before releasing goods, access, or an order.

## Instructions

Pick the flow first (Step 0), then follow the create path, the verify path, or both. Each step lists its success criterion.

### Step 0: Choose the request type

- The payment is a single SOL or SPL token transfer with a known amount and recipient -> **transfer request**. Go to Step 1.
- The payment needs arbitrary instructions, a program call, server-side pricing, a server-computed memo, or anything beyond one transfer -> **transaction request**. Go to Step 4.

Field tables for both URL shapes are in `resources/url-specs.md`. Read it before encoding so you use the correct keys (`amount` is decimal, not lamports; `spl-token` is the mint; `reference` is repeatable).

**Success criterion:** You know which request type matches the payment and have read the field table for it.

### Step 1: Generate a unique reference

Every request MUST carry its own unique `reference` public key, or you cannot tell two payments apart on chain. The reference is not a wallet and never signs or holds funds; it is a marker added as a read-only, non-signer account so the transaction is findable by it later.

```ts
import { Keypair } from "@solana/web3.js";
const reference = Keypair.generate().publicKey; // store this with the order
```

Persist `reference` (base58) alongside the order/invoice. You need it again in Step 7 to find the payment.

**Success criterion:** You have a fresh `reference` public key persisted with the order, distinct from any other open request.

### Step 2: Encode the transfer request URL

Use `encodeURL`. Amounts are `BigNumber` in whole token units (not lamports, not raw): `new BigNumber("1.5")` means 1.5 SOL, or 1.5 of the SPL token in its own decimals. Pass `splToken` (the mint `PublicKey`) only for SPL tokens; omit it for native SOL.

```ts
import { encodeURL } from "@solana/pay";
import BigNumber from "bignumber.js";
import { PublicKey } from "@solana/web3.js";

const url = encodeURL({
  recipient: new PublicKey(MERCHANT_WALLET),
  amount: new BigNumber("1.5"),
  // splToken: new PublicKey(USDC_MINT), // omit for native SOL
  reference,                              // from Step 1
  label: "Royal Coffee",                 // shown by the wallet
  message: "Order #1234",                // shown by the wallet
  memo: "RC-1234",                        // optional, written on chain (SPL memo)
});
```

`encodeURL` returns a `URL` object whose string is `solana:<recipient>?amount=...`. The `label` and `message` are display-only and are NOT enforced on chain; never rely on them for verification.

**Success criterion:** `url.toString()` starts with `solana:` and encodes the recipient, decimal amount, the reference, and (for SPL) the mint.

### Step 3: Render the QR code

```ts
import { createQR } from "@solana/pay";
const qr = createQR(url, 360, "transparent"); // size in px, optional background
// Browser: qr.append(document.getElementById("qr"))
// Node:    const buf = await qr.getRawData("png")  // Buffer for an <img> or file
```

`createQR` returns a `QRCodeStyling` instance. In a browser, `append` it to a container element. Server-side, call `getRawData("png")` to get bytes you can write to a file or return as an image response. Then go to Step 6 to verify, or hand off to your UI.

**Success criterion:** A scannable QR encoding the exact URL from Step 2 is rendered or serialized.

### Step 4: Build the transaction request endpoint (GET)

For a transaction request, the wallet first issues a `GET` to your link. Respond with the merchant identity. This shape is mandated by the spec.

```ts
// GET /api/pay
res.json({
  label: "Royal Coffee",
  icon: "https://merchant.example/icon.png", // https, square, png/svg/webp
});
```

**Success criterion:** `GET` returns `{ label, icon }` with an HTTPS icon URL.

### Step 5: Build the transaction request endpoint (POST)

The wallet then `POST`s `{ account: "<payer base58>" }`. Build the transaction for that payer, add the same unique `reference` as a read-only key, partially sign if your server must (fee payer or co-signer), serialize, and return base64. Include `feePayer`, a recent blockhash, and a `message` for the wallet to display.

```ts
// POST /api/pay  body: { account: string }
import { Transaction, PublicKey, SystemProgram } from "@solana/web3.js";

const payer = new PublicKey(req.body.account);
const tx = new Transaction({
  feePayer: payer,
  recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
});
tx.add(
  SystemProgram.transfer({ fromPubkey: payer, toPubkey: MERCHANT, lamports })
);
// add the reference as a read-only, non-signer key on the transfer instruction
tx.instructions[0].keys.push({ pubkey: reference, isSigner: false, isWritable: false });

const serialized = tx.serialize({ requireAllSignatures: false }).toString("base64");
res.json({ transaction: serialized, message: "Order #1234, 1.5 SOL" });
```

Return exactly `{ transaction: <base64>, message?: <string> }`. The wallet adds the payer signature and submits; you do not submit it. Then verify the same way as a transfer (Step 6). See `resources/url-specs.md` for the full request/response shapes.

**Success criterion:** `POST` returns a valid base64 transaction that includes the reference key, with the payer as fee payer and a fresh blockhash.

### Step 6: Wait for the payment to land (findReference)

After the request is shown, poll the chain for a transaction carrying your reference. `findReference` throws `FindReferenceError` until a matching transaction exists, so poll it on an interval; do not treat the throw as a hard failure.

```ts
import { findReference, FindReferenceError } from "@solana/pay";

let sigInfo;
while (true) {
  try {
    sigInfo = await findReference(connection, reference, { finality: "confirmed" });
    break; // found it
  } catch (e) {
    if (e instanceof FindReferenceError) {
      await new Promise((r) => setTimeout(r, 1500)); // not landed yet, keep polling
      continue;
    }
    throw e; // a real error
  }
}
```

Add an overall timeout so an unpaid request does not poll forever. `sigInfo.signature` is the transaction to validate next.

**Success criterion:** You have a `signature` for a confirmed transaction that references this request, or you stopped at your own timeout.

### Step 7: Validate the payment (validateTransfer)

Finding a transaction is not enough; it must match what you charged. `validateTransfer` re-reads the transaction and throws `ValidateTransferError` if the recipient, amount, token, or reference does not match. Only after this passes should you fulfill.

```ts
import { validateTransfer, ValidateTransferError } from "@solana/pay";

try {
  await validateTransfer(
    connection,
    sigInfo.signature,
    {
      recipient: new PublicKey(MERCHANT_WALLET),
      amount: new BigNumber("1.5"),
      // splToken: new PublicKey(USDC_MINT), // include for SPL, omit for SOL
      reference,
    },
    { commitment: "confirmed" }
  );
  // PAID and verified, safe to fulfill the order now
} catch (e) {
  if (e instanceof ValidateTransferError) {
    // a transaction exists but does NOT match (wrong amount/recipient/token), do NOT fulfill
  }
  throw e;
}
```

Pass the SAME values you encoded in the request, including `splToken` for SPL payments. Mark the order paid (idempotently, keyed by reference or signature) so a re-run does not double-fulfill.

**Success criterion:** `validateTransfer` resolves without throwing; the order is marked paid keyed by reference/signature so it cannot be fulfilled twice.

## Examples

### Example 1: Charge 1.5 SOL with a QR code, then confirm it paid

User asks: "Generate a Solana Pay QR for 1.5 SOL to my wallet and tell me when it's paid."

The agent:
1. **Choose type:** a single SOL transfer -> transfer request (Step 0).
2. **Unique reference:** `Keypair.generate().publicKey`, persisted with the order (Step 1).
3. **Encode:** `encodeURL({ recipient, amount: new BigNumber("1.5"), reference, label, message })`, no `splToken` for native SOL (Step 2).
4. **QR:** `createQR(url, 360)` appended to the page or written to PNG (Step 3).
5. **Find:** poll `findReference(connection, reference, { finality: "confirmed" })`, swallowing `FindReferenceError` until the tx lands (Step 6).
6. **Validate:** `validateTransfer(connection, signature, { recipient, amount, reference })`; on success report PAID; on `ValidateTransferError` report a mismatch and do not fulfill (Step 7).

`examples/create-payment-request.ts` produces the URL + QR; `examples/verify-payment.ts` runs the find/validate poll.

### Example 2: USDC payment

Same as Example 1 with two changes: pass `splToken: new PublicKey(USDC_MINT)` to BOTH `encodeURL` and `validateTransfer`, and express `amount` in USDC units (`new BigNumber("9.99")` for 9.99 USDC; the SDK applies the mint's decimals). Forgetting `splToken` in `validateTransfer` validates against a SOL transfer that never happened and always throws.

### Example 3: Transaction request for a non-transfer payment

User asks: "I need the payment to also call my loyalty program, not just transfer." A transfer request cannot do this. Stand up an endpoint (Steps 4 and 5): `GET` returns `{ label, icon }`; `POST { account }` builds a transaction with the transfer plus the loyalty instruction, pushes the unique `reference` as a read-only key, returns `{ transaction: <base64>, message }`. Encode the request as `encodeURL({ link: new URL("https://merchant.example/api/pay") })`. Verify identically with `findReference` + `validateTransfer` (Steps 6 and 7) against the transfer portion.

## Guidelines

- **DO** generate a fresh, unique `reference` per request and persist it with the order. It is the only reliable on-chain handle to that specific payment.
- **DO** treat `reference` as a marker only: a non-signer, read-only key. It never holds funds and never signs.
- **DO** express `amount` as a `BigNumber` in whole token units. `new BigNumber("1.5")`, never lamports or raw base units; the SDK applies decimals.
- **DO** pass `splToken` (the mint) consistently to BOTH `encodeURL` and `validateTransfer` for SPL payments, and omit it for both on native SOL.
- **DO** poll `findReference` and catch `FindReferenceError` as "not yet," with an overall timeout. The throw is expected before the tx lands.
- **DO** always call `validateTransfer` before fulfilling. Finding a transaction proves it exists, not that it paid you the right amount.
- **DO** make fulfillment idempotent, keyed by reference or signature, so a retry or a refresh cannot double-deliver.
- **DON'T** trust `label`, `message`, or `memo` for verification. They are display/annotation only and are not enforced on chain.
- **DON'T** reuse a `reference` across requests. Two requests sharing a reference are indistinguishable, and `findReference` may match the wrong payment.
- **DON'T** submit the transaction-request transaction yourself. Your server partially signs and returns base64; the wallet adds the payer signature and submits.
- **DON'T** mark an order paid on a scanned QR, a wallet "success" toast, or a `findReference` hit alone. Only a passing `validateTransfer` is proof.
- **DON'T** return anything but `{ transaction, message? }` from a transaction-request `POST`, or `{ label, icon }` from its `GET`; wallets reject off-spec responses.

## Common Errors

### Error: `FindReferenceError: not found`
**Cause:** Normal before the payment lands, or the request was never paid, or you are querying the wrong cluster, or `reference` was never attached to the transaction as a key.
**Solution:** Treat it as "keep polling" with a timeout, not a failure. If it never resolves, confirm the payer used this exact URL on the same cluster and that the reference was added as a read-only key (transaction requests must push it onto an instruction).

### Error: `ValidateTransferError: amount not transferred to recipient` (or wrong recipient/token)
**Cause:** The transaction exists but does not match the request: wrong amount, wrong recipient, or `splToken` mismatched (e.g. omitted for a USDC payment so it validates as SOL).
**Solution:** Pass `validateTransfer` the EXACT values you encoded, including `splToken` for SPL. Do NOT fulfill on this error; it can indicate an underpayment or a spoofed transaction.

### Error: amount is off by orders of magnitude
**Cause:** Passed lamports/raw base units instead of whole token units, or used a JS `number` and lost precision.
**Solution:** Always `new BigNumber("1.5")` in whole units. The SDK converts to lamports/base units using the token's decimals. Never pass `number`.

### Error: wallet rejects the transaction request
**Cause:** The `POST` response was not exactly `{ transaction: <base64>, message? }`, the transaction lacked a fee payer or a recent blockhash, or `serialize` demanded all signatures.
**Solution:** Set `feePayer` to the posted account, set a fresh `recentBlockhash`, serialize with `{ requireAllSignatures: false }`, and return only the spec fields. Use HTTPS for the link and the icon.

### Error: an order gets fulfilled twice
**Cause:** Re-running verification (refresh, retry, restart) and treating each `validateTransfer` pass as a new payment.
**Solution:** Persist a paid flag keyed by `reference` (or signature) and check it before fulfilling; make fulfillment idempotent.

## References

- `resources/url-specs.md`: transfer-request and transaction-request field tables (`encodeURL` inputs, the `GET`/`POST` request and response shapes), with the on-chain vs display-only distinction.
- `examples/create-payment-request.ts`: generate a unique reference, `encodeURL` a transfer request, render with `createQR`, and print the URL. Runnable with `@solana/pay`, `@solana/web3.js`, `bignumber.js`.
- `examples/verify-payment.ts`: poll `findReference` (swallowing `FindReferenceError`) then `validateTransfer`, returning a PAID / mismatch / timeout verdict.
- Solana Pay spec: https://docs.solanapay.com/spec
- Solana Pay docs: https://docs.solanapay.com
- `@solana/pay` source: https://github.com/anza-xyz/solana-pay
- `@solana/pay` on npm: https://www.npmjs.com/package/@solana/pay
