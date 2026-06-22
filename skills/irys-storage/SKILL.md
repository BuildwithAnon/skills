---
name: irys-storage
description: Upload files and NFT/JSON metadata to permanent Arweave storage paid for with SOL, using Irys (formerly Bundlr). Use when a user needs permanent or immutable storage on Solana, wants to upload an image, file, or NFT metadata JSON and get a permanent URL, asks how to pay for Arweave with SOL, mentions Irys, Bundlr, Arweave, gateway.irys.xyz, or arweave.net, or needs to host Metaplex/Token Metadata JSON that wallets and marketplaces can render. Keywords: Irys, Arweave, Bundlr, permanent storage, immutable storage, NFT metadata upload, upload image to Arweave, pay Arweave with SOL, gateway.irys.xyz, @irys/upload, @irys/upload-solana.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Irys Permanent Storage (pay with SOL)

Upload any file or JSON document to Arweave permanent storage and pay in SOL through Irys (the network formerly called Bundlr). The result is a content-addressed URL that never changes and, for mainnet uploads, never expires. This is the standard way to host NFT images and Token Metadata JSON for Solana NFTs without running your own Arweave node.

## Overview

A Solana NFT points at off-chain metadata: an image and a JSON document describing it. That data has to live somewhere permanent, or the NFT breaks the day the host goes down. Irys solves this by writing the bytes to Arweave (permanent, content-addressed storage) while letting you pay in SOL instead of AR. You fund a small prepaid balance from your Solana wallet, upload, and get back a transaction id that resolves at `https://gateway.irys.xyz/<id>` forever.

The model has three properties that drive every decision in this skill:

1. **Prepaid balance, not pay-per-call.** You must fund Irys *before* you upload. An unfunded upload fails. Funding is an on-chain SOL transaction, so the credited balance can lag a few seconds behind the send.
2. **Byte-based pricing.** Cost is a function of payload size, quoted in *atomic* units of the funding token (lamports for SOL). Always convert with `irys.utils`, never hand-roll the math.
3. **A free tier for small payloads.** On mainnet, payloads under roughly 100 KiB are free, so a typical NFT JSON document needs no funding, while a full-resolution image does. (Flag: the ~100 KiB free threshold is documented behavior, not a hard guarantee. If the exact cutoff is load-bearing for your flow, confirm the current value in the Irys docs.)

Use this skill when the task is "store this permanently" or "upload NFT metadata," not when the user only needs temporary or mutable hosting (use ordinary object storage for that) or when they want to *mint* the NFT (that is Metaplex Token Metadata; this skill produces the URI it consumes).

The package lineage matters. Irys was Bundlr, and the SDK has split twice: `@bundlr-network/client` (oldest) -> `@irys/sdk` (legacy, the `new Irys({...})` constructor) -> the **current** split packages used here. For new Solana code, use the split packages and the `Uploader(Solana).withWallet(...)` builder. Do NOT use the legacy `@irys/sdk` constructor.

## Instructions

Follow these steps in order. Each has a success criterion; do not proceed until it is met.

### Step 1: Install the current packages

For a Node.js / server-side uploader:

```bash
npm install @irys/upload @irys/upload-solana
```

For a browser / wallet-adapter context, use the web variants instead:

```bash
npm install @irys/web-upload @irys/web-upload-solana
```

`@irys/upload-solana` depends on `@solana/web3.js ^1.95.3`. Current versions: `@irys/upload` 0.0.15, `@irys/upload-solana` 0.1.8. Pin or confirm the latest minor before publishing production code, since these move.

**Success criterion:** the two split packages are installed. You are NOT importing from `@irys/sdk` or `@bundlr-network/client`.

### Step 2: Construct the uploader

Build it with the `Uploader(Solana).withWallet(...)` pattern. The wallet argument is either a base58-encoded private key string OR the JSON byte array from a Solana keypair file (the same array `solana-keygen` writes).

Mainnet (permanent, paid for payloads over the free tier):

```ts
import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";

const irys = await Uploader(Solana).withWallet(privateKey);
```

Devnet (free, but data is deleted after ~60 days; an RPC URL is REQUIRED):

```ts
const irys = await Uploader(Solana)
  .withWallet(privateKey)
  .withRpc("https://api.devnet.solana.com")
  .devnet();
```

Omit `.withRpc(...)` and `.devnet()` for mainnet. The constructor is `async`; always `await` it. Read the private key from an environment variable or keypair file, never a literal in source.

**Success criterion:** `irys.address` returns the funding wallet's address, and you have chosen mainnet (permanent) vs devnet (ephemeral, RPC set) deliberately.

### Step 3: Size the payload and get a price quote

Stat the file (or measure the buffer length) and ask Irys what it costs. Pricing is per byte and returns *atomic* units.

```ts
import { statSync } from "node:fs";

const size = statSync(path).size;            // bytes
const price = await irys.getPrice(size);     // atomic units (lamports for SOL)
```

For an in-memory payload, pass `Buffer.byteLength(data)` instead of a file size.

**Success criterion:** you have a byte count and a `price` in atomic units. If `price` is `0` (small mainnet payload under the free tier), you may skip funding entirely.

### Step 4: Fund the prepaid balance (before uploading)

If `price > 0`, fund the balance from your Solana wallet. `fund` takes an atomic amount; `irys.utils` converts between human and atomic units.

```ts
if (price > 0n) {
  await irys.fund(price);   // pre-pays the upload; on-chain SOL tx
}
```

Funding is an on-chain transaction, so the credited balance can lag the send by a few seconds. To avoid an under-funded upload, fund slightly extra or keep a small standing balance. Check the live balance any time with `await irys.getBalance()`.

To fund a fixed SOL amount instead of an exact quote, convert first:

```ts
const atomic = irys.utils.toAtomic(0.02);  // 0.02 SOL -> lamports
await irys.fund(atomic);
```

**Success criterion:** for any payload over the free tier, the funding transaction has settled and the Irys balance covers `price`. NEVER call upload before this for a paid payload.

### Step 5: Upload and build the URL

Upload the file (or raw data) and read the transaction id off the receipt. The id is the permanent address.

```ts
const receipt = await irys.uploadFile(path);
const url = `https://gateway.irys.xyz/${receipt.id}`;
```

For an in-memory payload, use `irys.upload(data, { tags })`. For a directory, use `irys.uploadFolder(dir, { ... })`.

**Success criterion:** you have a `receipt.id` and a `https://gateway.irys.xyz/<id>` URL that resolves to the uploaded bytes.

### Step 6: Tag content so wallets render it (metadata uploads)

When the payload is JSON metadata, set its `Content-Type` tag so wallets and marketplaces parse it as JSON rather than downloading it as an opaque blob. Tags are an array of `{ name, value }`.

```ts
const receipt = await irys.upload(JSON.stringify(metadata), {
  tags: [{ name: "Content-Type", value: "application/json" }],
});
```

Tag image uploads with their real MIME type too (`image/png`, `image/jpeg`, etc.) so they preview correctly.

**Success criterion:** JSON metadata carries `Content-Type: application/json`; images carry their image MIME type. The final NFT metadata JSON references the already-uploaded image URL.

### NFT metadata flow (full sequence)

For an NFT, run Steps 3 to 6 twice: image first, then the JSON that points at it.

1. Stat -> getPrice -> fund -> `uploadFile(imagePath)` -> `imageUrl = https://gateway.irys.xyz/<imgId>`.
2. Build the Token Metadata JSON with `image: imageUrl` (and the same URL in `properties.files`).
3. getPrice (likely `0` under the free tier) -> fund if needed -> `upload(json, { tags: [{ name: "Content-Type", value: "application/json" }] })`.
4. Hand the resulting `https://gateway.irys.xyz/<jsonId>` to your mint as the metadata `uri`.

## Examples

### Example 1: Upload a single file and get a permanent URL

User input: "Upload `./logo.png` to Arweave and give me a permanent link, paying with my SOL wallet."

The agent runs the procedure:

1. **Construct** the mainnet uploader from the wallet key in an env var.
2. **Size:** `statSync("./logo.png").size` -> e.g. `184320` bytes.
3. **Quote:** `await irys.getPrice(184320)` -> a non-zero atomic price (the image is over the free tier).
4. **Fund:** `price > 0n`, so `await irys.fund(price)`; wait for the on-chain tx.
5. **Upload:** `await irys.uploadFile("./logo.png")` -> `receipt.id`.
6. **Report:** `https://gateway.irys.xyz/<id>` (also resolves at `https://arweave.net/<id>` for mainnet permanent data).

`examples/upload-file.ts` runs exactly this flow for any path.

### Example 2: Upload NFT metadata (image then JSON)

User input: "I'm minting an NFT. Upload the artwork and the metadata JSON and give me a `uri` for Metaplex."

The agent:

1. Uploads the image (Steps 3 to 5), tagging it `image/png`, and captures `imageUrl`.
2. Builds Token Metadata JSON with `name`, `symbol`, `description`, `image: imageUrl`, `attributes`, and `properties.files[0].uri = imageUrl`.
3. Quotes the JSON (small, likely free), funds only if `price > 0`, and uploads it with `tags: [{ name: "Content-Type", value: "application/json" }]`.
4. Returns the JSON's `https://gateway.irys.xyz/<id>` as the metadata `uri` to pass to the mint instruction.

`examples/upload-nft-metadata.ts` runs this two-step flow end to end.

### Example 3: Devnet dry run

User input: "Let me test the upload flow for free first."

The agent constructs the uploader with `.withRpc("https://api.devnet.solana.com").devnet()`, runs the same stat -> getPrice -> (fund) -> upload sequence, and warns the user that devnet data is deleted after ~60 days and must not be used as a production NFT `uri`. Re-upload on mainnet before minting anything real.

## Guidelines

- **DO** use the current split packages (`@irys/upload` + `@irys/upload-solana`) and the `Uploader(Solana).withWallet(...)` builder for new code.
- **DO** fund before uploading any payload over the free tier. The balance is prepaid; an unfunded upload fails.
- **DO** convert amounts with `irys.utils.toAtomic` / `fromAtomic`. Prices and `fund()` use atomic units (lamports for SOL).
- **DO** stat the payload and call `getPrice(size)` first, so you fund the right amount and skip funding when the quote is `0`.
- **DO** tag JSON metadata with `Content-Type: application/json` and images with their real MIME type so wallets and marketplaces render them.
- **DO** account for funding lag: it is an on-chain tx, so fund slightly extra or keep a standing balance for batch uploads.
- **DON'T** use the legacy `@irys/sdk` `new Irys({...})` constructor or `@bundlr-network/client` for new Solana code.
- **DON'T** call `withRpc` / `devnet()` for mainnet, and DON'T forget `withRpc` for devnet (devnet requires it).
- **DON'T** use a devnet upload as an NFT `uri`. Devnet data is deleted after ~60 days.
- **DON'T** hardcode the private key in source. Read it from an env var or keypair file.
- **DON'T** assume small uploads are always free without checking. Confirm the current free threshold in the docs if it is load-bearing.

## Common Errors

### Error: upload rejected for insufficient balance
**Cause:** uploading before funding, or funding less than `getPrice(size)` returned, on a payload over the free tier. Irys is prepaid; the balance must cover the byte cost at upload time.
**Solution:** call `getPrice(size)` and `await irys.fund(price)` before `uploadFile`. Verify with `await irys.getBalance()`.

### Error: funded but balance still shows zero / upload still fails
**Cause:** `fund()` is an on-chain SOL transaction; the credited Irys balance lags the send by a few seconds.
**Solution:** wait for confirmation (the `fund` promise resolving means the tx was sent), re-check `getBalance()`, and fund slightly extra to absorb the lag in batch flows.

### Error: devnet uploader throws on construction or upload
**Cause:** `.devnet()` was called without `.withRpc(...)`. Devnet requires an explicit RPC URL.
**Solution:** chain `.withRpc("https://api.devnet.solana.com").devnet()`. For mainnet, omit both.

### Error: NFT metadata downloads as a file instead of rendering in the wallet
**Cause:** the JSON was uploaded without a `Content-Type` tag, so the gateway serves it as `application/octet-stream`.
**Solution:** upload with `tags: [{ name: "Content-Type", value: "application/json" }]`. Re-upload to get a new id.

### Error: `new Irys is not a constructor` / type errors importing the constructor
**Cause:** using the legacy `@irys/sdk` `new Irys({...})` API (or `@bundlr-network/client`) instead of the current split packages.
**Solution:** install `@irys/upload` + `@irys/upload-solana` and use `await Uploader(Solana).withWallet(key)`.

### Error: amount looks 1e9x too large or too small
**Cause:** mixing human SOL values with atomic (lamport) values. `getPrice` and `fund` speak atomic units.
**Solution:** convert with `irys.utils.toAtomic(solAmount)` before `fund`, and `irys.utils.fromAtomic(price)` only for display.

## References

- `resources/setup-and-pricing.md` - package lineage and current versions, the `Uploader(Solana).withWallet` construction, base58 vs keypair-array wallet input, atomic units and `irys.utils`, the free-tier threshold, and the devnet vs mainnet differences.
- `examples/upload-file.ts` - stat -> getPrice -> fund (if needed) -> uploadFile -> gateway URL, runnable with `@irys/upload` + `@irys/upload-solana`.
- `examples/upload-nft-metadata.ts` - upload an image, then upload Token Metadata JSON tagged `Content-Type: application/json` that references the image URL, returning a mint-ready `uri`.
- Irys docs: https://docs.irys.xyz
- Irys Solana SDK: https://docs.irys.xyz/build/d/sdk/setup
- Irys gateway: https://gateway.irys.xyz
- Arweave gateway (mainnet permanent data): https://arweave.net
- Metaplex Token Metadata standard: https://developers.metaplex.com/token-metadata/token-standard
