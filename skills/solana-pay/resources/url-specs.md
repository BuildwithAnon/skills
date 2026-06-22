# Solana Pay URL Specs: Field Reference

The lookup tables for encoding both Solana Pay request types and for the transaction-request endpoint contract. Use these when building the `encodeURL` input or the `GET`/`POST` handlers. A field marked "display only" is shown by the wallet but NOT enforced on chain, so it can never be used for verification.

There are two request types. A URL whose path is a base58 address is a **transfer request**; a URL whose path is an `https://` link is a **transaction request**.

```
transfer request:     solana:<recipient>?amount=1.5&spl-token=<mint>&reference=<ref>&label=...&message=...&memo=...
transaction request:  solana:https://merchant.example/api/pay
```

## Transfer request: `encodeURL` input

`encodeURL(fields)` returns a `URL`. The TypeScript field names (left) differ from the URL query keys they produce (right).

| `encodeURL` field | URL key | Type | Required | Meaning | On chain? |
|-------------------|---------|------|----------|---------|-----------|
| `recipient` | path | `PublicKey` | YES | Address that receives the payment. For SPL, the SDK targets the recipient's associated token account for the mint. | Yes (the credited account) |
| `amount` | `amount` | `BigNumber` | No* | Amount in WHOLE token units (`"1.5"` = 1.5 SOL or 1.5 of the token). SDK applies decimals; never lamports/raw. | Yes (validated) |
| `splToken` | `spl-token` | `PublicKey` (mint) | No | The SPL token mint. Omit for native SOL. | Yes (which token) |
| `reference` | `reference` | `PublicKey \| PublicKey[]` | No (but use it) | Unique marker key(s) added as read-only non-signer account(s) so the tx is findable later. Repeatable. | Yes (as account keys) |
| `label` | `label` | `string` | No | Merchant/source name the wallet shows the payer. | No, display only |
| `message` | `message` | `string` | No | Description the wallet shows the payer (e.g. order id). | No, display only |
| `memo` | `memo` | `string` | No | SPL Memo written into the transaction. | Yes (memo), but not amount-bound |

\* `amount` is optional in the spec (a wallet may prompt the payer), but for a fixed charge always set it, and validate against it.

Notes:
- `amount` is a `bignumber.js` `BigNumber`, e.g. `new BigNumber("9.99")`. Passing a JS `number` risks precision loss.
- `reference` is THE handle for verification. Generate a throwaway `Keypair.generate().publicKey` per request, persist it, and reuse it in `findReference` / `validateTransfer`. It never signs and never holds funds.
- `label` / `message` / `memo` must not be trusted for verification; only `recipient`, `amount`, `splToken`, and `reference` are checked by `validateTransfer`.

## Transfer request: `parseURL` output

`parseURL(url)` parses a `solana:` string back into fields. For a transfer request it returns a `TransferRequestURL`:

| Field | Type | Notes |
|-------|------|-------|
| `recipient` | `PublicKey` | From the path. |
| `amount` | `BigNumber \| undefined` | Decimal whole units, if present. |
| `splToken` | `PublicKey \| undefined` | Mint, if present. |
| `reference` | `PublicKey[] \| undefined` | Always an array when present. |
| `label` / `message` / `memo` | `string \| undefined` | Display/annotation. |

If the URL path is an `https://` link, `parseURL` instead returns a `TransactionRequestURL` with `{ link: URL, label?, message? }`. Branch on which shape you get.

## Transaction request: `encodeURL` input

| `encodeURL` field | Type | Required | Meaning |
|-------------------|------|----------|---------|
| `link` | `URL` | YES | HTTPS endpoint the wallet calls. Produces `solana:<link>`. |
| `label` | `string` | No | Optional display label (the `GET` response can also supply one). |
| `message` | `string` | No | Optional display message. |

```ts
encodeURL({ link: new URL("https://merchant.example/api/pay") });
```

## Transaction request: endpoint contract

The wallet drives a two-call handshake against `link`. Both responses must match the spec exactly or wallets reject them.

### GET `link`: merchant identity

Response JSON:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `label` | `string` | YES | Merchant/source name shown to the payer. |
| `icon` | `string` (URL) | YES | HTTPS URL to a square icon (SVG/PNG/WebP). |

```json
{ "label": "Royal Coffee", "icon": "https://merchant.example/icon.png" }
```

### POST `link`: build the transaction

Request body (sent by the wallet):

| Field | Type | Meaning |
|-------|------|---------|
| `account` | `string` (base58) | The payer's public key, so the server can build a transaction for them. |

Response JSON:

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `transaction` | `string` (base64) | YES | A serialized transaction. Set `feePayer` to `account`, set a recent blockhash, partially sign if the server is a co-signer/fee payer, and serialize with `{ requireAllSignatures: false }`. |
| `message` | `string` | No | Description the wallet shows before signing. |

```json
{ "transaction": "<base64-serialized-tx>", "message": "Order #1234, 1.5 SOL" }
```

Rules:
- Push the SAME unique `reference` onto an instruction's `keys` as `{ isSigner: false, isWritable: false }` so the resulting transaction is findable by `findReference`.
- The wallet adds the payer's signature and submits. The server NEVER submits the transaction.
- Use HTTPS for `link` and `icon`. Return only the listed fields.

## Verification API (both request types)

| Function | Signature (shape) | Throws | Use |
|----------|-------------------|--------|-----|
| `findReference` | `(connection, reference, { finality })` -> `ConfirmedSignatureInfo` | `FindReferenceError` until a matching tx exists | Locate the payment by its reference. Poll it. |
| `validateTransfer` | `(connection, signature, { recipient, amount, splToken?, reference }, { commitment })` -> `TransactionResponse` | `ValidateTransferError` on any mismatch | Confirm the found tx paid the exact recipient/amount/token/reference. |

- `findReference` throwing `FindReferenceError` is the normal "not landed yet" signal; poll with a timeout.
- `validateTransfer` must receive the SAME values you encoded, including `splToken` for SPL. A passing call is the only proof of payment.

## Common mints (mainnet)

| Token | Mint |
|-------|------|
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| USDT | `Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB` |
| Native SOL | omit `splToken` entirely |

## Version note

These field names and the `encodeURL` / `parseURL` / `createQR` / `findReference` / `validateTransfer` / `FindReferenceError` / `ValidateTransferError` exports match the documented `@solana/pay` API (latest published is the `0.2.x` line). Confirm the exact installed version on npm before pinning: https://www.npmjs.com/package/@solana/pay. The package depends on `bignumber.js` for `amount` and on `@solana/web3.js` for keys and the `Connection`.
