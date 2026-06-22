# Irys Setup and Pricing Reference

The lookup behind the SKILL.md steps: which packages to install, how to build the uploader, how amounts and pricing work, and how devnet differs from mainnet.

## Package lineage (use the current split)

Irys was previously called Bundlr. The client SDK has changed twice. Pick the right one for new code.

| Generation | Package(s) | Constructor / builder | Use for new Solana code? |
|------------|-----------|-----------------------|--------------------------|
| Oldest | `@bundlr-network/client` | `new Bundlr(...)` | No |
| Legacy | `@irys/sdk` | `new Irys({ url, token, key })` | No |
| Current (server) | `@irys/upload` + `@irys/upload-solana` | `await Uploader(Solana).withWallet(key)` | **Yes** |
| Current (browser) | `@irys/web-upload` + `@irys/web-upload-solana` | `await WebUploader(WebSolana).withProvider(...)` | **Yes (browser)** |

Do NOT use the legacy `new Irys({...})` constructor or `@bundlr-network/client` for new Solana uploaders.

### Current versions (verified 2026)

- `@irys/upload` 0.0.15 (core `Uploader`)
- `@irys/upload-solana` 0.1.8 (the Solana connector, exports `Solana`)
- `@irys/upload-solana` depends on `@solana/web3.js ^1.95.3`

These versions move; pin or confirm the latest minor before shipping production code.

### Install

Server:

```bash
npm install @irys/upload @irys/upload-solana
```

Browser:

```bash
npm install @irys/web-upload @irys/web-upload-solana
```

## Construction

```ts
import { Uploader } from "@irys/upload";
import { Solana } from "@irys/upload-solana";

// Mainnet: permanent storage, paid for payloads over the free tier.
const irys = await Uploader(Solana).withWallet(privateKey);
```

`Uploader(Solana)` is the builder; `withWallet` sets the payer; the whole thing is `async`, so `await` it. `irys.address` returns the funding wallet address after construction.

### Wallet input

`withWallet` accepts either form:

- A **base58-encoded private key string** (e.g. what Phantom exports).
- The **JSON byte array** from a Solana keypair file (the array `solana-keygen new` writes to `~/.config/solana/id.json`). Read it with `JSON.parse(readFileSync(path, "utf8"))` and pass the array.

Never hardcode the key. Load it from an environment variable or keypair file.

## Atomic units and `irys.utils`

Prices and `fund()` amounts are in **atomic** units of the funding token. For SOL, atomic = lamports (1 SOL = 1e9 lamports). Always convert; never multiply by `1e9` by hand.

```ts
irys.utils.toAtomic(0.02);     // 0.02 SOL -> atomic (lamports), for fund()
irys.utils.fromAtomic(price);  // atomic -> human SOL, for display only
```

| Method | Returns | Units |
|--------|---------|-------|
| `irys.getPrice(bytes)` | upload cost | atomic |
| `irys.fund(atomicAmount)` | funding receipt | takes atomic |
| `irys.getBalance()` | prepaid balance | atomic |
| `irys.utils.toAtomic(n)` | converted amount | atomic |
| `irys.utils.fromAtomic(n)` | converted amount | human |

## Pricing model

- **Prepaid.** You fund a balance, then spend it on uploads. An upload that exceeds the balance fails. There is no pay-per-call billing.
- **Byte-based.** Cost is a function of payload size only: `getPrice(numberOfBytes)`.
- **Funding lag.** `fund()` is an on-chain SOL transaction. The credited Irys balance can trail the send by a few seconds. For batch uploads, fund a little extra or keep a standing balance.

### Free tier

On mainnet, payloads under roughly **100 KiB** are free to upload. So a typical NFT metadata JSON (a few KB) usually uploads with no funding, while a full-resolution image typically does not.

Flag: the ~100 KiB free threshold is documented behavior, not a guarantee. If the exact cutoff matters to your flow (for example deciding whether to skip funding programmatically), the robust pattern is to call `getPrice(size)` and only fund when it returns greater than `0`. Confirm the current threshold in the Irys docs if it is load-bearing.

## Core methods

| Method | Purpose |
|--------|---------|
| `irys.getPrice(bytes)` | quote the atomic cost for a payload of `bytes` |
| `irys.fund(atomicAmount)` | pre-pay the balance from the Solana wallet (on-chain tx) |
| `irys.getBalance()` | read the current prepaid balance (atomic) |
| `irys.uploadFile(path)` | upload a file from disk; returns a receipt with `.id` |
| `irys.upload(data, { tags })` | upload an in-memory string/Buffer; returns receipt `.id` |
| `irys.uploadFolder(dir, { ... })` | upload a directory of files |
| `irys.address` | the funding wallet address |
| `irys.utils.toAtomic / fromAtomic` | unit conversion |

### Tags

Tags are an array of `{ name, value }` objects attached at upload time. The important one for rendering is `Content-Type`:

```ts
tags: [{ name: "Content-Type", value: "application/json" }]   // JSON metadata
tags: [{ name: "Content-Type", value: "image/png" }]          // PNG image
```

Without a correct `Content-Type`, the gateway serves the bytes as `application/octet-stream` and wallets/marketplaces will not render the JSON or preview the image.

## Devnet vs mainnet

| | Mainnet | Devnet |
|--|---------|--------|
| Permanence | Permanent (Arweave) | Deleted after ~60 days |
| Cost | Free under ~100 KiB, paid above | Free |
| RPC | optional (uses a default) | **required** via `.withRpc(...)` |
| Builder suffix | none | `.devnet()` |
| Safe as NFT `uri`? | Yes | **No** (ephemeral) |

```ts
// Devnet: free testing, ephemeral data, RPC required.
const irys = await Uploader(Solana)
  .withWallet(privateKey)
  .withRpc("https://api.devnet.solana.com")
  .devnet();
```

Omit `.withRpc(...)` and `.devnet()` for mainnet. Never use a devnet upload as a production NFT `uri`; re-upload on mainnet before minting anything real.

## URLs

Every upload is content-addressed by its transaction id (`receipt.id`):

- Canonical Irys gateway: `https://gateway.irys.xyz/<id>`
- Mainnet permanent data also resolves at: `https://arweave.net/<id>`

The id is stable forever for mainnet uploads; the URL is the value you store as an NFT's `image` or metadata `uri`.
