/**
 * subscribe-accounts.ts
 *
 * Subscribe to a real-time Yellowstone Geyser gRPC stream of every account
 * owned by a given program, at a chosen commitment, with a keepalive ping and
 * automatic reconnect-with-backoff.
 *
 * This is provider-agnostic. Point it at any Yellowstone endpoint (Triton,
 * Helius LaserStream, QuickNode Yellowstone, or self-hosted) via env vars.
 *
 * Install:
 *   npm i @triton-one/yellowstone-grpc bs58
 *
 * Run:
 *   GRPC_ENDPOINT="https://your-endpoint:10000" \
 *   GRPC_TOKEN="your-token" \
 *   PROGRAM_ID="TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" \
 *   COMMITMENT=confirmed \
 *     npx tsx subscribe-accounts.ts
 *
 * Optional narrowing (ANDed onto the owner filter):
 *   DATASIZE=165                       account data length must equal this
 *   MEMCMP_OFFSET=32 MEMCMP_BASE58=... raw bytes at this offset must equal this
 */

import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";

const ENDPOINT = required("GRPC_ENDPOINT");
const TOKEN = process.env.GRPC_TOKEN ?? ""; // some self-hosted nodes need no token
const PROGRAM_ID =
  process.env.PROGRAM_ID ?? "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

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

/** Build the account-data filters (datasize + memcmp) from env, if provided. */
function buildAccountDataFilters(): unknown[] {
  const filters: unknown[] = [];
  if (process.env.DATASIZE) {
    filters.push({ datasize: Number(process.env.DATASIZE) });
  }
  if (process.env.MEMCMP_OFFSET && process.env.MEMCMP_BASE58) {
    filters.push({
      memcmp: {
        offset: process.env.MEMCMP_OFFSET, // raw byte offset into the account layout
        base58: process.env.MEMCMP_BASE58,
      },
    });
  }
  return filters;
}

/** A SubscribeRequest that streams all accounts owned by PROGRAM_ID. */
function buildRequest(): Record<string, unknown> {
  return {
    accounts: {
      byOwner: {
        account: [],
        owner: [PROGRAM_ID],
        filters: buildAccountDataFilters(),
      },
    },
    // Everything else stays empty so we only get account updates.
    transactions: {},
    transactionsStatus: {},
    slots: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: COMMITMENT,
  };
}

/** A minimal request body carrying only a keepalive ping. */
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

/** One full connect -> subscribe -> read cycle. Resolves when the stream ends. */
async function runOnce(): Promise<void> {
  const client = new Client(ENDPOINT, TOKEN, undefined);
  const stream = await client.subscribe();

  let pingTimer: ReturnType<typeof setInterval> | undefined;

  const done = new Promise<void>((resolve, reject) => {
    stream.on("data", (update: any) => {
      if (update.account) {
        const a = update.account.account;
        console.log(
          `[account] slot=${update.account.slot}` +
            ` pubkey=${toBase58(a?.pubkey)}` +
            ` owner=${toBase58(a?.owner)}` +
            ` lamports=${a?.lamports}` +
            ` dataLen=${a?.data ? a.data.length : 0}` +
            ` filters=${(update.filters ?? []).join(",")}`,
        );
      } else if (update.pong) {
        // keepalive acknowledged
      } else if (update.ping) {
        // server asked for a pong; replying with our own ping keeps it happy
        void writeRequest(stream, pingRequest(1)).catch(() => {});
      }
    });

    stream.on("error", (e: unknown) => reject(e));
    stream.on("end", () => resolve());
    stream.on("close", () => resolve());
  });

  await writeRequest(stream, buildRequest());
  console.log(
    `Subscribed: accounts owned by ${PROGRAM_ID} @ commitment=${COMMITMENT}. Waiting for updates...`,
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

/** Reconnect forever with exponential backoff. */
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
