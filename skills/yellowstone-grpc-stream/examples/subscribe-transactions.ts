/**
 * subscribe-transactions.ts
 *
 * Subscribe to a real-time Yellowstone Geyser gRPC stream of every transaction
 * that mentions a target account (accountInclude), skipping vote and failed
 * transactions, with a keepalive ping and automatic reconnect-with-backoff.
 *
 * Provider-agnostic. Point it at any Yellowstone endpoint (Triton, Helius
 * LaserStream, QuickNode Yellowstone, or self-hosted) via env vars.
 *
 * Install:
 *   npm i @triton-one/yellowstone-grpc bs58
 *
 * Run:
 *   GRPC_ENDPOINT="https://your-endpoint:10000" \
 *   GRPC_TOKEN="your-token" \
 *   ACCOUNT="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4" \
 *   COMMITMENT=confirmed \
 *     npx tsx subscribe-transactions.ts
 *
 * accountInclude  = tx must reference AT LEAST ONE of these (what we use here)
 * accountRequired = tx must reference ALL of these (stricter; set REQUIRED=a,b)
 */

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";

const ENDPOINT = required("GRPC_ENDPOINT");
const TOKEN = process.env.GRPC_TOKEN ?? "";
const ACCOUNT =
  process.env.ACCOUNT ?? "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";
const REQUIRED = (process.env.REQUIRED ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const COMMITMENT = pickCommitment(process.env.COMMITMENT);

const PING_INTERVAL_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function pickCommitment(s?: string): CommitmentLevel {
  switch ((s ?? "confirmed").toLowerCase()) {
    case "processed":
      return CommitmentLevel.PROCESSED;
    case "finalized":
      return CommitmentLevel.FINALIZED;
    default:
      return CommitmentLevel.CONFIRMED;
  }
}

/** Stream transactions mentioning ACCOUNT, excluding vote + failed txs. */
function buildRequest(): Record<string, unknown> {
  return {
    transactions: {
      mentionsAccount: {
        vote: false,
        failed: false,
        accountInclude: [ACCOUNT],
        accountExclude: [],
        accountRequired: REQUIRED,
      },
    },
    // Everything else empty so we only get transaction updates.
    accounts: {},
    transactionsStatus: {},
    slots: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: COMMITMENT,
  };
}

function pingRequest(id: number): Record<string, unknown> {
  return {
    accounts: {},
    transactions: {},
    transactionsStatus: {},
    slots: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: { id },
  };
}

function toBase58(bytes: Uint8Array | Buffer | undefined): string {
  if (!bytes) return "";
  return bs58.encode(Buffer.from(bytes));
}

async function writeRequest(
  stream: { write: (req: unknown, cb: (err: unknown) => void) => void },
  req: unknown,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(req, (err: unknown) => (err ? reject(err) : resolve()));
  });
}

async function runOnce(): Promise<void> {
  const client = new Client(ENDPOINT, TOKEN, undefined);
  const stream = await client.subscribe();

  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const done = new Promise<void>((resolve, reject) => {
    stream.on("data", (update: any) => {
      if (update.transaction) {
        const tx = update.transaction.transaction;
        const sig = toBase58(tx?.signature);
        const err = tx?.meta?.err ? "FAILED" : "ok";
        console.log(
          `[tx] slot=${update.transaction.slot}` +
            ` sig=${sig}` +
            ` status=${err}` +
            ` filters=${(update.filters ?? []).join(",")}`,
        );
      } else if (update.pong) {
        // keepalive acknowledged
      } else if (update.ping) {
        void writeRequest(stream, pingRequest(1)).catch(() => {});
      }
    });

    stream.on("error", (e: unknown) => reject(e));
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });

  await writeRequest(stream, buildRequest());
  console.log(
    `Subscribed: transactions mentioning ${ACCOUNT}` +
      (REQUIRED.length ? ` (required: ${REQUIRED.join(", ")})` : "") +
      ` @ commitment=${COMMITMENT}. Waiting for updates...`,
  );

  pingTimer = setInterval(() => {
    void writeRequest(stream, pingRequest(1)).catch(() => {});
  }, PING_INTERVAL_MS);

  try {
    await done;
  } finally {
    if (pingTimer) clearInterval(pingTimer);
  }
}

async function main(): Promise<void> {
  let backoff = 1_000;
  for (;;) {
    try {
      await runOnce();
      console.error("Stream ended by server; reconnecting...");
      backoff = 1_000;
    } catch (e) {
      console.error(`Stream error: ${(e as Error)?.message ?? e}`);
      console.error(`Reconnecting in ${backoff}ms...`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
