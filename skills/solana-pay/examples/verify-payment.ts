/**
 * verify-payment.ts
 *
 * Confirm a Solana Pay payment landed and matches the request, in two steps:
 *   1. findReference   : poll the chain for a tx carrying this request's unique
 *                        reference. It throws FindReferenceError until the tx
 *                        appears, so swallow that and keep polling (with a
 *                        timeout) rather than treating it as a failure.
 *   2. validateTransfer: re-read that tx and assert the recipient, amount,
 *                        token, and reference all match what was charged. It
 *                        throws ValidateTransferError on any mismatch. Only a
 *                        passing validateTransfer is proof of payment.
 *
 * Run:
 *   # Pin bignumber.js to v9 to match @solana/pay (a v10+ BigNumber is a
 *   # structurally incompatible type and will not type-check here).
 *   npm i @solana/pay @solana/web3.js bignumber.js@^9
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *   RECIPIENT=<wallet> AMOUNT=1.5 REFERENCE=<ref-from-create-step> \
 *     npx tsx verify-payment.ts
 *   # SPL token: add SPL_TOKEN=<mint> (must match the request exactly)
 *
 * Exit code: 0 = PAID and verified, 2 = mismatch (do NOT fulfill), 3 = timeout.
 *
 * Targets the @solana/pay 0.2.x API.
 */

import {
  findReference,
  validateTransfer,
  FindReferenceError,
  ValidateTransferError,
} from "@solana/pay";
import { Connection, PublicKey } from "@solana/web3.js";
import BigNumber from "bignumber.js";

type Verdict =
  | { status: "paid"; signature: string }
  | { status: "mismatch"; signature: string; reason: string }
  | { status: "timeout" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll findReference until the payment lands or the deadline passes. */
async function awaitPayment(
  connection: Connection,
  reference: PublicKey,
  opts: { timeoutMs: number; intervalMs: number }
): Promise<string | null> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    try {
      const sigInfo = await findReference(connection, reference, {
        finality: "confirmed",
      });
      return sigInfo.signature; // found it
    } catch (e) {
      if (e instanceof FindReferenceError) {
        // Expected: the payment has not landed yet. Keep polling.
        await sleep(opts.intervalMs);
        continue;
      }
      throw e; // a real RPC/other error
    }
  }
  return null; // timed out, never paid
}

/**
 * Validate the found tx against the exact request. Returns a verdict.
 * verify() only ever yields "paid" or "mismatch" (the "timeout" arm of Verdict
 * is decided earlier, by awaitPayment), so its return type excludes "timeout"
 * and the caller can narrow on status without a stray timeout case.
 */
async function verify(
  connection: Connection,
  signature: string,
  expected: {
    recipient: PublicKey;
    amount: BigNumber;
    splToken?: PublicKey;
    reference: PublicKey;
  }
): Promise<Exclude<Verdict, { status: "timeout" }>> {
  try {
    await validateTransfer(
      connection,
      signature,
      {
        recipient: expected.recipient,
        amount: expected.amount,
        splToken: expected.splToken, // MUST match the request (omit for SOL)
        reference: expected.reference,
      },
      { commitment: "confirmed" }
    );
    return { status: "paid", signature };
  } catch (e) {
    if (e instanceof ValidateTransferError) {
      // A tx exists but does NOT match (wrong amount/recipient/token). Do not fulfill.
      return { status: "mismatch", signature, reason: e.message };
    }
    throw e;
  }
}

async function main() {
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const recipientStr = process.env.RECIPIENT;
  const amountStr = process.env.AMOUNT ?? "1.5";
  const referenceStr = process.env.REFERENCE;
  const splTokenStr = process.env.SPL_TOKEN;

  if (!recipientStr || !referenceStr) {
    console.error(
      "Usage: RECIPIENT=<wallet> AMOUNT=<decimal> REFERENCE=<ref> [SPL_TOKEN=<mint>] npx tsx verify-payment.ts"
    );
    process.exit(1);
  }

  const connection = new Connection(rpc, "confirmed");
  const expected = {
    recipient: new PublicKey(recipientStr),
    amount: new BigNumber(amountStr),
    splToken: splTokenStr ? new PublicKey(splTokenStr) : undefined,
    reference: new PublicKey(referenceStr),
  };

  console.log("Waiting for payment (polling findReference)...");
  const signature = await awaitPayment(connection, expected.reference, {
    timeoutMs: 1000 * 60 * 5, // 5 min; tune to your checkout window
    intervalMs: 1500,
  });

  if (!signature) {
    console.log("VERDICT: TIMEOUT, no transaction referenced this request in time.");
    process.exit(3);
  }

  console.log(`Found tx ${signature}; validating it matches the request...`);
  const verdict = await verify(connection, signature, expected);

  if (verdict.status === "paid") {
    console.log(`VERDICT: PAID, ${verdict.signature}`);
    console.log("  Safe to fulfill the order now (do so idempotently, keyed by reference/signature).");
    process.exit(0);
  } else {
    console.log(`VERDICT: MISMATCH, ${verdict.signature}`);
    console.log(`  reason: ${verdict.reason}`);
    console.log("  DO NOT fulfill: amount/recipient/token did not match the request.");
    process.exit(2);
  }
}

main().catch((e) => {
  console.error("verify-payment failed:", e);
  process.exit(1);
});
