/**
 * list-and-bid.ts
 *
 * Two maker actions on Tensor via the REST API:
 *   1. List an NFT for sale         -> GET /tx/list
 *   2. Place a collection-wide bid  -> GET /tx/collection_bid (returns a bidState)
 *
 * Both follow the same pattern: fetch a fresh blockhash, GET the built tx,
 * deserialize txs[0].txV0, sign with the maker wallet, send, confirm.
 *
 * The collection bid returns a bidState address. Persist it: it is the
 * bidAddress someone (or you) passes to /tx/sell to fill the bid, and what you
 * pass to cancel the bid.
 *
 * The Tensor REST API is ALPHA and the key is gated (apply via the Airtable
 * form on https://dev.tensor.trade). Header must be exactly x-tensor-api-key.
 *
 * Run:
 *   npm i @solana/web3.js
 *   TENSOR_API_KEY=...  \
 *   RPC_URL=https://api.mainnet-beta.solana.com  \
 *   MAKER_SECRET_KEY='[12,34,...]'    # JSON array of the 64-byte secret key
 *   LIST_MINT=<mint>  LIST_PRICE_LAMPORTS=5000000000  \
 *   BID_COLLECTION_SLUG=tensorians  BID_PRICE_LAMPORTS=4000000000  BID_QUANTITY=1
 *   npx tsx list-and-bid.ts
 */

import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

const BASE = "https://api.mainnet.tensordev.io/api/v1";

interface TxResponseRest {
  txs: Array<{
    txV0: string;
    tx?: unknown;
    lastValidBlockHeight?: number;
    metadata?: Record<string, unknown>;
  }>;
  bidState?: string;
}

function apiKey(): string {
  const k = process.env.TENSOR_API_KEY;
  if (!k) {
    throw new Error(
      "TENSOR_API_KEY is not set. The Tensor REST key is gated; apply via the " +
        "Airtable form on https://dev.tensor.trade. Do not hardcode a key."
    );
  }
  return k;
}

/** GET helper with the exact x-tensor-api-key header and retry/backoff. */
async function tensorGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "x-tensor-api-key": apiKey() } });
      if (res.status === 429 || res.status >= 500) throw new Error(`transient ${res.status}`);
      if (!res.ok) throw new Error(`Tensor ${path} -> ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function resolveCollId(slug: string): Promise<string> {
  const data = await tensorGet<any>("/collections/findcollection", { slug });
  const collId =
    data?.collId ?? data?.collection?.collId ?? data?.collections?.[0]?.collId;
  if (!collId) {
    throw new Error(
      `Could not resolve collId for "${slug}". Check findcollection shape against https://dev.tensor.trade/llms.txt`
    );
  }
  return String(collId);
}

/**
 * Build (GET), deserialize, sign, send, and confirm one /tx/* transaction.
 * Returns the signature and any bidState the response surfaced.
 */
async function buildSignSend(
  connection: Connection,
  signer: Keypair,
  path: string,
  params: Record<string, string>
): Promise<{ sig: string; bidState?: string }> {
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const built = await tensorGet<TxResponseRest>(path, { ...params, blockhash });
  const txV0 = built.txs?.[0]?.txV0;
  if (!txV0) throw new Error(`No txV0 in ${path} response.`);

  const tx = VersionedTransaction.deserialize(Buffer.from(txV0, "base64"));
  tx.sign([signer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });

  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash,
      lastValidBlockHeight: built.txs[0].lastValidBlockHeight ?? lastValidBlockHeight,
    },
    "confirmed"
  );

  // bidState may appear at the top level or inside metadata (ALPHA: read defensively).
  const bidState =
    built.bidState ?? (built.txs[0].metadata?.bidState as string | undefined);
  return { sig, bidState };
}

async function main() {
  const connection = new Connection(
    process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const secret = process.env.MAKER_SECRET_KEY;
  if (!secret) throw new Error("Set MAKER_SECRET_KEY to a JSON array of the 64-byte secret key.");
  const maker = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));
  const owner = maker.publicKey.toBase58();

  // --- 1. List an NFT for sale ---
  const listMint = process.env.LIST_MINT;
  const listPrice = process.env.LIST_PRICE_LAMPORTS;
  if (listMint && listPrice) {
    const { sig } = await buildSignSend(connection, maker, "/tx/list", {
      mint: listMint,
      owner,
      price: listPrice, // lamports
    });
    console.log(`Listed ${listMint} for ${listPrice} lamports. Sig: ${sig}`);
  } else {
    console.log("Skipping list (set LIST_MINT and LIST_PRICE_LAMPORTS to enable).");
  }

  // --- 2. Place a collection bid ---
  const bidSlug = process.env.BID_COLLECTION_SLUG;
  const bidPrice = process.env.BID_PRICE_LAMPORTS;
  const bidQty = process.env.BID_QUANTITY ?? "1";
  if (bidSlug && bidPrice) {
    const collId = await resolveCollId(bidSlug);
    const { sig, bidState } = await buildSignSend(
      connection,
      maker,
      "/tx/collection_bid",
      {
        owner,
        price: bidPrice, // lamports, per item
        quantity: bidQty,
        collId,
      }
    );
    console.log(`Collection bid placed on ${bidSlug} (${collId}). Sig: ${sig}`);
    console.log(
      `SAVE THIS bidState: ${bidState ?? "(not found in response; inspect shape)"} ` +
        `-> use it as bidAddress to fill (/tx/sell) or to cancel the bid.`
    );
  } else {
    console.log("Skipping bid (set BID_COLLECTION_SLUG and BID_PRICE_LAMPORTS to enable).");
  }
}

main().catch((e) => {
  console.error("list-and-bid failed:", e);
  process.exit(1);
});
