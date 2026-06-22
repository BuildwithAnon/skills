/**
 * get-floor-and-buy.ts
 *
 * Read the floor of a Tensor collection and buy the cheapest listing.
 *
 * Flow:
 *   findcollection (slug -> collId)
 *   -> GET /mint/active_listings (sortBy=PriceAsc, limit=1) for the floor
 *   -> GET /tx/buy  (returns a built versioned tx)
 *   -> deserialize txV0 -> sign with buyer wallet -> send -> confirm.
 *
 * Works identically for compressed NFTs: /tx/buy resolves compression and the
 * Merkle proof server-side, so this client passes no proof arguments.
 *
 * The Tensor REST API is ALPHA and the key is gated (apply via the Airtable
 * form on https://dev.tensor.trade). Header must be exactly x-tensor-api-key.
 *
 * Run:
 *   npm i @solana/web3.js
 *   TENSOR_API_KEY=...  \
 *   RPC_URL=https://api.mainnet-beta.solana.com  \
 *   BUYER_SECRET_KEY='[12,34,...]'   # JSON array of the 64-byte secret key
 *   COLLECTION_SLUG=tensorians       # or set MINT + OWNER to skip the floor read
 *   npx tsx get-floor-and-buy.ts
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
}

interface FloorListing {
  mint: string;
  owner: string;
  price: string; // lamports, as a string from the API
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

/** GET helper with the exact x-tensor-api-key header and small retry/backoff. */
async function tensorGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = `${BASE}${path}?${new URLSearchParams(params)}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { "x-tensor-api-key": apiKey() } });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`transient ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`Tensor ${path} -> ${res.status} ${await res.text()}`);
      }
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      // exponential backoff with jitter; rate limits are not published.
      const delay = 250 * 2 ** attempt + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Resolve a human collection slug/name to a Tensor collId. */
async function resolveCollId(slug: string): Promise<string> {
  // ALPHA: read defensively; the exact response shape may shift.
  const data = await tensorGet<any>("/collections/findcollection", { slug });
  const collId =
    data?.collId ?? data?.collection?.collId ?? data?.collections?.[0]?.collId;
  if (!collId) {
    throw new Error(
      `Could not resolve collId for "${slug}". Inspect findcollection response shape against https://dev.tensor.trade/llms.txt`
    );
  }
  return String(collId);
}

/** Read the cheapest active listing (the floor). */
async function readFloor(collId: string): Promise<FloorListing> {
  const data = await tensorGet<any>("/mint/active_listings", {
    collId,
    sortBy: "PriceAsc",
    limit: "1",
  });
  // Tolerate a couple of plausible shapes (ALPHA).
  const item = data?.listings?.[0] ?? data?.mints?.[0] ?? data?.[0];
  const mint = item?.mint ?? item?.onchainId;
  const owner = item?.owner ?? item?.listing?.seller ?? item?.seller;
  const price = item?.price ?? item?.listing?.price;
  if (!mint || !owner || price == null) {
    throw new Error(
      "active_listings did not return a usable floor (mint/owner/price). " +
        "Check the response shape; the API is ALPHA."
    );
  }
  return { mint: String(mint), owner: String(owner), price: String(price) };
}

async function main() {
  const connection = new Connection(
    process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed"
  );

  const secret = process.env.BUYER_SECRET_KEY;
  if (!secret) throw new Error("Set BUYER_SECRET_KEY to a JSON array of the 64-byte secret key.");
  const buyer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret)));

  // Either read the floor from a collection, or buy a specific listing directly.
  let mint = process.env.MINT;
  let owner = process.env.OWNER;
  let priceLamports = process.env.PRICE_LAMPORTS;

  if (!mint || !owner) {
    const slug = process.env.COLLECTION_SLUG;
    if (!slug) throw new Error("Set COLLECTION_SLUG, or set MINT + OWNER (+ PRICE_LAMPORTS).");
    const collId = await resolveCollId(slug);
    const floor = await readFloor(collId);
    mint = floor.mint;
    owner = floor.owner;
    priceLamports = floor.price;
    console.log(`Floor: mint=${mint} owner=${owner} price=${priceLamports} lamports`);
  }

  // Slippage guard: allow up to floor + 2% so a small move still fills.
  if (!priceLamports) {
    throw new Error("No price available to set maxPrice. Provide PRICE_LAMPORTS or read the floor.");
  }
  const maxPrice = ((BigInt(priceLamports) * 102n) / 100n).toString();

  // Build the buy tx with a fresh blockhash.
  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const built = await tensorGet<TxResponseRest>("/tx/buy", {
    buyer: buyer.publicKey.toBase58(),
    mint,
    owner,
    maxPrice,
    blockhash,
    includeTotalCost: "true",
  });

  const txV0 = built.txs?.[0]?.txV0;
  if (!txV0) throw new Error("No txV0 in /tx/buy response.");

  const tx = VersionedTransaction.deserialize(Buffer.from(txV0, "base64"));
  tx.sign([buyer]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  console.log(`Sent buy: ${sig}`);

  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash,
      lastValidBlockHeight: built.txs[0].lastValidBlockHeight ?? lastValidBlockHeight,
    },
    "confirmed"
  );
  console.log(`Confirmed. Bought ${mint} for up to ${maxPrice} lamports.`);
}

main().catch((e) => {
  console.error("get-floor-and-buy failed:", e);
  process.exit(1);
});
