---
name: solana-name-service
description: Resolve and manage .sol domains with the Solana Name Service (SNS, formerly Bonfida). Use to turn a human-readable .sol name into the wallet that should receive funds, list every domain a wallet owns, do a reverse lookup from a domain account to its name, find a wallet's primary domain, or register a new domain and subdomains. Keywords: SNS, .sol domain, Solana Name Service, Bonfida, name service, resolve .sol, reverse lookup, primary domain, getAllDomains, registerDomainNameV2, who owns this domain, where to send funds.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Name Service

A procedure for working with `.sol` domains through the Solana Name Service (SNS, the protocol formerly branded Bonfida): resolve a name to the address that should receive funds, list a wallet's domains, reverse a domain account back to its name, read a wallet's primary domain, and register new domains and subdomains. The one rule that matters above all others: to decide where to send funds, use `resolve()`, never the raw registry owner.

## Overview

A `.sol` domain is a human-readable alias for a Solana address, the SNS equivalent of DNS plus an ENS-style record system. Agents reach for it in two directions:

- **Forward**: "send 1 SOL to `bonfida.sol`" needs the name turned into an address.
- **Reverse**: "what is the name of the wallet `HKKp...`?" needs the address turned back into a name.

The forward case has a trap. A domain has a **registry owner** (the account that controls the name) and, separately, a user-declared **SOL record** (the wallet the owner wants payments sent to). These are often different addresses. The high-level `resolve()` function honors the full SNS-IP-5 priority order and returns the correct payout target. The low-level `NameRegistryState.retrieve()` returns only the registry owner and silently ignores SOL records, so using it to route a payment can send funds to the wrong wallet. Always resolve with `resolve()` for "where do funds go / who is this".

Use this skill when a user wants to:

1. Resolve a `.sol` name to an address (to send funds, look up an identity, or fill a recipient field).
2. List every `.sol` domain a wallet owns, with their names.
3. Reverse a domain account public key back to its `.sol` name.
4. Read a wallet's primary (formerly "favorite") domain.
5. Register a new `.sol` domain, or create and transfer subdomains.

This skill targets `@bonfida/spl-name-service` (v3, peer dep `@solana/web3.js` v1).

## Setup

```bash
npm i @bonfida/spl-name-service @solana/web3.js
```

- The package is `@bonfida/spl-name-service` (version 3.0.23 at time of writing). The repo is `github.com/SolanaNameService/sns-sdk`.
- Do NOT install the unscoped `sns-sdk` package on npm. It is a different, unrelated product and will not expose these functions.
- The peer dependency is `@solana/web3.js` **v1** (`^1.98.2`). v1 functions return `PublicKey` objects, so call `.toBase58()` to get a string. This skill is not written for `@solana/kit` (web3.js v2).
- React frontends can use the companion hooks package `@bonfida/sns-react`.

## Instructions

Run only the steps the task needs. The forward path (Steps 1 to 3) and the reverse/listing path (Steps 4 to 6) are independent.

### Step 0: Normalize the name

Strip the `.sol` suffix before passing a name to any SDK function. The SDK expects the bare label.

- `bonfida.sol` -> pass `"bonfida"`.
- `sub.bonfida.sol` -> pass `"sub.bonfida"` (subdomains keep the parent label, still no `.sol`).

**Success criterion:** the name you hand to the SDK has no `.sol` suffix.

### Step 1: Resolve a name to its funds-recipient address (the default forward path)

This is the function to reach for whenever the question is "who is this name / where should funds go".

```ts
import { resolve } from "@bonfida/spl-name-service";

const owner = await resolve(connection, "bonfida"); // returns a PublicKey
console.log(owner.toBase58());
```

`resolve()` follows the SNS-IP-5 priority order and returns the first match:

1. If the domain is a **tokenized NFT**, the current NFT holder.
2. Else if a valid **SOL record V2** exists, the address it points to.
3. Else if a valid **SOL record V1** exists, the address it points to.
4. Else the **registry owner**.

This is why `resolve()` is correct and `registry.owner` is not: a domain owner can publish a SOL record pointing payments at a different wallet, and `resolve()` honors it.

**Success criterion:** you have a `PublicKey` (call `.toBase58()` for the string) that reflects SOL records and NFT tokenization, not just the registry owner.

### Step 2: When (and only when) to use the low-level registry owner

Use `NameRegistryState.retrieve()` only when you specifically need the **registry owner** (the account that administratively controls the name), not the payout target, for example to check whether a wallet can manage the domain. It ignores SOL records and can be stale relative to a tokenized domain.

```ts
import { getDomainKeySync, NameRegistryState } from "@bonfida/spl-name-service";

const { pubkey } = getDomainKeySync("bonfida"); // derive the domain account key
const { registry, nftOwner } = await NameRegistryState.retrieve(connection, pubkey);
const registryOwner = registry.owner; // administrative owner, NOT necessarily the payout wallet
```

If `nftOwner` is set, the domain is tokenized and that NFT holder is the effective owner. Do NOT use `registry.owner` to route a payment. Go to Step 1 for that.

**Success criterion:** you can articulate why you are bypassing `resolve()`, and you are reading administrative control, not a payment target.

### Step 3: Register a domain or manage subdomains

Registration builds instruction(s) you then sign and send. Default payment is in USDC.

```ts
import { registerDomainNameV2 } from "@bonfida/spl-name-service";
import { PublicKey } from "@solana/web3.js";

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

// space: bytes of storage to allocate for the domain account (up to 10000).
const ixs = await registerDomainNameV2(
  connection,
  "my-new-name", // no .sol
  1_000, // space in bytes
  buyer, // PublicKey paying and receiving the domain
  buyerUsdcTokenAccount, // buyer's USDC associated token account
  USDC_MINT,
  // referrerKey?  // optional
);
// Add ixs to a transaction, sign with the buyer, and send.
```

Subdomains and records:

- `createSubdomain(connection, "sub.parent.sol", owner)` to create a subdomain (this call accepts the dotted form per the SDK).
- `transferSubdomain(...)` to transfer one.
- `getRecordV2(connection, "bonfida", record)` / `getRecordV2Key(...)` for records. Use the V2 record API; V1 record helpers are deprecated.

The signature above is the v3 shape. The SDK has changed argument order across major versions, so if you pin a different major, confirm it against the installed `dist/*.d.ts`.

**Success criterion:** you produced registration instruction(s) (or a subdomain/record call).

### Step 4: List the domains a wallet owns

Prefer the variant that also returns names so you do not have to reverse each one yourself.

```ts
import { getDomainKeysWithReverses, getAllDomains } from "@bonfida/spl-name-service";

// Preferred: returns [{ pubKey, domain }] with names already resolved.
const withNames = await getDomainKeysWithReverses(connection, owner);
for (const d of withNames) {
  console.log(d.domain, d.pubKey.toBase58());
}

// Keys only (PublicKey[]), if you do not need names:
const keys = await getAllDomains(connection, owner);
```

**Success criterion:** you have the wallet's domain accounts, with names when you used `getDomainKeysWithReverses`.

### Step 5: Reverse a domain account to its name

Given a domain account public key (for example one returned by `getAllDomains`), get its `.sol` label.

```ts
import { reverseLookup } from "@bonfida/spl-name-service";

const name = await reverseLookup(connection, domainPubkey); // e.g. "bonfida"
```

`performReverseLookup` is a legacy alias for the same thing; prefer `reverseLookup`.

**Success criterion:** you have the human-readable name for the domain account.

### Step 6: Read a wallet's primary domain

A wallet can designate one **primary** domain (the name renamed from "favorite" in v3.0.0).

```ts
import { getPrimaryDomain } from "@bonfida/spl-name-service";

const { domain, reverse, stale } = await getPrimaryDomain(connection, owner);
if (stale) {
  // The wallet is no longer the owner of this primary domain. Do not trust it
  // as the wallet's identity without re-verifying ownership.
}
console.log(reverse); // the .sol name string
```

`getFavoriteDomain` is a deprecated alias for `getPrimaryDomain`. Always check the `stale` flag: a stale result means the recorded primary domain is no longer owned by this wallet and should not be shown as the wallet's name.

**Success criterion:** you have the wallet's primary `.sol` name and you have checked `stale` before trusting it.

## Examples

### Example 1: Send funds to a .sol name

User input: "Send 0.5 SOL to `toly.sol`."

The agent:

1. Normalizes: strip `.sol` -> `"toly"`.
2. Resolves with `resolve(connection, "toly")` (NOT `NameRegistryState.retrieve`), because the recipient may have published a SOL record pointing to a different payout wallet.
3. Builds a `SystemProgram.transfer` to the resolved `PublicKey`.
4. Simulates, then sends.

The load-bearing line is using `resolve()` so the SOL record is honored. `examples/resolve-and-reverse.ts` runs this resolution.

### Example 2: Show a wallet's identity in a UI

User input: "What is the .sol name for `HKKp...`?"

The agent calls `getPrimaryDomain(connection, owner)`. If `stale === false`, it shows `reverse` as the wallet's name. If `stale === true`, it falls back to truncating the address, because the recorded primary is no longer owned by this wallet. `examples/list-domains.ts` includes the primary-domain read.

### Example 3: List all domains a wallet holds

User input: "Which `.sol` domains does this wallet own?"

The agent calls `getDomainKeysWithReverses(connection, owner)` and prints each `domain` with its `pubKey.toBase58()`. It does not call `getAllDomains` plus a manual `reverseLookup` loop, because `getDomainKeysWithReverses` already returns the names in one pass. `examples/list-domains.ts` runs exactly this.

## Guidelines

- **DO** use `resolve()` for "where to send funds / who is this name". It honors NFT tokenization and SOL records.
- **DO** strip the `.sol` suffix before passing a name to the SDK (except the few helpers like `createSubdomain` that take the dotted form).
- **DO** call `.toBase58()` on returned `PublicKey` objects when you need a string (this is web3.js v1).
- **DO** prefer `getDomainKeysWithReverses` over `getAllDomains` plus a manual reverse loop when you need names.
- **DO** check the `stale` flag on `getPrimaryDomain` before treating the result as a wallet's identity.
- **DO** use `registerDomainNameV2` (not the deprecated V1 registrar) for paid registration, and pass the buyer's USDC associated token account for the default USDC payment.
- **DON'T** use `NameRegistryState.retrieve().registry.owner` to decide where to send funds. It ignores SOL records and can be stale.
- **DON'T** install the unscoped `sns-sdk` npm package. The correct package is `@bonfida/spl-name-service`.
- **DON'T** assume `@solana/kit` (web3.js v2) types. This SDK's peer dep is web3.js v1.
- **DON'T** use the deprecated aliases (`getFavoriteDomain`, `performReverseLookup`, V1 record helpers) in new code. Prefer `getPrimaryDomain`, `reverseLookup`, and the V2 record API.

## Common Errors

### Error: funds sent to the wrong wallet

**Cause:** Used `NameRegistryState.retrieve().registry.owner` (or `getDomainKeySync` + retrieve) to route a payment. The domain had a SOL record pointing the payout at a different wallet, which the registry owner ignores.
**Solution:** Use `resolve(connection, name)`. It returns the SNS-IP-5 priority result (NFT holder, then SOL record V2/V1, then registry owner), which is the address the owner declared for payments.

### Error: function not found / wrong types

**Cause:** Installed the unscoped `sns-sdk` package, or expected `@solana/kit` (web3.js v2) return types.
**Solution:** Install `@bonfida/spl-name-service` with `@solana/web3.js` v1. Returned `PublicKey`s use the v1 API; call `.toBase58()` for strings.

### Error: resolution returns nothing / "domain does not exist"

**Cause:** Passed the name with the `.sol` suffix, or passed an unregistered name.
**Solution:** Strip `.sol` (Step 0). Confirm the name is registered; an unregistered name has no registry account to resolve.

### Error: showing a stale name as the wallet's identity

**Cause:** Used `getPrimaryDomain`'s `reverse` without checking `stale`. The wallet transferred the domain away but the primary-domain record still points at it.
**Solution:** Treat the result as valid only when `stale === false`. On `stale === true`, fall back to the truncated address.

### Error: registration call throws on argument shape

**Cause:** Argument order or the `space`/token-account parameters did not match the installed SDK version.
**Solution:** Open `node_modules/@bonfida/spl-name-service/dist/*.d.ts` and match `registerDomainNameV2`'s exact signature. `space` is bytes (up to 10000), and the token account must be the buyer's USDC associated token account for the default USDC payment.

## References

- `resources/addresses-and-records.md` - SNS program ids and constants (NAME_PROGRAM_ID, ROOT_DOMAIN_ACCOUNT, REGISTER_PROGRAM_ID, CENTRAL_STATE, USDC mint), and a detailed explanation of SOL record vs registry owner and the `resolve()` priority order.
- `examples/resolve-and-reverse.ts` - resolve a name to its funds-recipient address via `resolve()`, then reverse a domain account back to its name. Runnable with `@bonfida/spl-name-service` + `@solana/web3.js`.
- `examples/list-domains.ts` - list a wallet's domains with names via `getDomainKeysWithReverses`, and read its primary domain with the `stale` check.
- SNS SDK repo: https://github.com/SolanaNameService/sns-sdk
- `@bonfida/spl-name-service` on npm: https://www.npmjs.com/package/@bonfida/spl-name-service
- React hooks: https://www.npmjs.com/package/@bonfida/sns-react
