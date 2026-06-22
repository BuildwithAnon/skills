/**
 * create-payment-request.ts
 *
 * Build a Solana Pay TRANSFER REQUEST: generate a unique reference, encode the
 * payment as a `solana:` URL, and render it as a QR code. The reference is a
 * throwaway public key (never signs, never holds funds) that you persist with
 * the order and reuse later to find and validate the payment on chain.
 *
 * Run:
 *   npm i @solana/pay @solana/web3.js bignumber.js
 *   RECIPIENT=<your-wallet> AMOUNT=1.5 npx tsx create-payment-request.ts
 *   # SPL token instead of SOL:
 *   RECIPIENT=<wallet> AMOUNT=9.99 SPL_TOKEN=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
 *     npx tsx create-payment-request.ts
 *
 * Output: the encoded URL, the reference to persist, and (in Node) a written
 * solana-pay-qr.png. In a browser you would `qr.append(container)` instead.
 *
 * Targets the @solana/pay 0.2.x API.
 */

import { encodeURL, createQR } from "@solana/pay";
import { Keypair, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { writeFile } from "node:fs/promises";

interface PaymentRequest {
  url: string;
  reference: string; // base58, persist this with the order
  recipient: string;
  amount: string;
  splToken?: string;
}

function buildTransferRequest(opts: {
  recipient: PublicKey;
  amount: BigNumber;
  splToken?: PublicKey;
  label: string;
  message: string;
  memo?: string;
}): { url: URL; reference: PublicKey } {
  // A fresh, UNIQUE reference per request. Without this you cannot tell two
  // payments apart on chain. It is a marker only: read-only, non-signer.
  const reference = Keypair.generate().publicKey;

  const url = encodeURL({
    recipient: opts.recipient,
    amount: opts.amount, // WHOLE token units, not lamports/raw
    splToken: opts.splToken, // undefined => native SOL
    reference,
    label: opts.label, // display only, NOT verified on chain
    message: opts.message, // display only, NOT verified on chain
    memo: opts.memo, // on chain (SPL memo), but not amount-bound
  });

  return { url, reference };
}

async function main() {
  const recipientStr = process.env.RECIPIENT;
  const amountStr = process.env.AMOUNT ?? "1.5";
  const splTokenStr = process.env.SPL_TOKEN; // omit for native SOL

  if (!recipientStr) {
    console.error("Usage: RECIPIENT=<wallet> AMOUNT=<decimal> [SPL_TOKEN=<mint>] npx tsx create-payment-request.ts");
    process.exit(1);
  }

  const recipient = new PublicKey(recipientStr);
  const amount = new BigNumber(amountStr); // BigNumber, never a JS number
  const splToken = splTokenStr ? new PublicKey(splTokenStr) : undefined;

  const { url, reference } = buildTransferRequest({
    recipient,
    amount,
    splToken,
    label: "Royal Coffee",
    message: "Order #1234",
    memo: "RC-1234",
  });

  const result: PaymentRequest = {
    url: url.toString(),
    reference: reference.toBase58(),
    recipient: recipient.toBase58(),
    amount: amount.toString(),
    splToken: splToken?.toBase58(),
  };

  console.log("PAYMENT REQUEST");
  console.log(`  url:        ${result.url}`);
  console.log(`  reference:  ${result.reference}   <- PERSIST with the order`);
  console.log(`  recipient:  ${result.recipient}`);
  console.log(`  amount:     ${result.amount}${splToken ? " (SPL)" : " SOL"}`);

  // Render the QR. In a browser: createQR(url, 360).append(containerEl).
  // In Node, serialize it to a PNG file.
  const qr = createQR(url, 360, "transparent");
  const png = (await qr.getRawData("png")) as Buffer | Blob | null;
  if (png) {
    const buf = png instanceof Buffer ? png : Buffer.from(await (png as Blob).arrayBuffer());
    await writeFile("solana-pay-qr.png", buf);
    console.log("  qr:         wrote solana-pay-qr.png");
  } else {
    console.log("  qr:         createQR returned no raw data in this environment");
  }

  // Hand result.reference to verify-payment.ts to confirm the payment lands.
}

main().catch((e) => {
  console.error("create-payment-request failed:", e);
  process.exit(1);
});
