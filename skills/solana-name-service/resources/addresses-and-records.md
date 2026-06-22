# SNS Addresses, Constants, and SOL Record vs Registry Owner

Lookup data for the Solana Name Service (SNS, formerly Bonfida) and a full explanation of the one thing agents get wrong: routing a payment to the registry owner instead of the resolved address.

## Program ids and constants

These are exported by `@bonfida/spl-name-service` and are mainnet values. Prefer importing the constants from the package over hardcoding strings, so you stay aligned with the installed version.

| Constant | Value | What it is |
|----------|-------|------------|
| `NAME_PROGRAM_ID` | `namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX` | The SPL Name Service program that owns all name registry accounts. |
| `ROOT_DOMAIN_ACCOUNT` | `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx` | The root domain account; the `.sol` TLD parent that domain keys derive under. |
| `REGISTER_PROGRAM_ID` | `jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR` | The registrar program that handles paid domain registration. |
| `CENTRAL_STATE` | `33m47vH6Eav6jr5Ry86XjhRft2jRBLDnDgPSHoquXi2Z` | The central state class account that owns reverse-lookup registries (maps a domain account back to its name). |
| `USDC_MINT` (default payment) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | USDC mint, the default currency for `registerDomainNameV2`. |

These are the mainnet constants for v3. Import them from `@bonfida/spl-name-service` rather than copying the strings, so you stay aligned with the installed version automatically.

## Naming and key derivation

- Always pass domain names **without** the `.sol` suffix to SDK functions (`"bonfida"`, not `"bonfida.sol"`). Subdomains keep the dotted parent label but still drop `.sol` (`"sub.bonfida"`), with the exception of a few helpers like `createSubdomain` that accept the dotted `.sol` form.
- `getDomainKeySync(name)` derives the on-chain domain account (the "domain key" / `pubkey`) from a name synchronously, without an RPC call. The derivation hashes the name under `ROOT_DOMAIN_ACCOUNT` and the name program.
- A reverse-lookup registry, owned by the central state class, stores the human name keyed by the domain account, which is what `reverseLookup` reads.

## SOL record vs registry owner: the core distinction

A `.sol` domain carries two different notions of "owner", and conflating them is the most common and most expensive SNS bug.

### Registry owner (administrative control)

`NameRegistryState.retrieve(connection, domainKey)` returns `{ registry, nftOwner }`. `registry.owner` is the account that **administratively controls** the name: it can update records, create subdomains, transfer the domain, and so on. If the domain has been tokenized into an NFT, `nftOwner` is set and the NFT holder is the effective controller.

`registry.owner` answers "who controls this name", NOT "where should I send money".

### SOL record (declared payout target)

The domain owner can publish a **SOL record** (V2 or the older V1) that declares the wallet payments should go to. This is deliberately separable from the registry owner: an owner can hold the name with one wallet (often a cold wallet or a multisig) while directing incoming SOL to a different hot wallet. The SOL record, when present and valid, is the payment target the owner intends.

### resolve() and the SNS-IP-5 priority order

`resolve(connection, name)` returns the correct funds-recipient `PublicKey` by walking the SNS-IP-5 priority order and returning the first match:

1. **Tokenized NFT holder.** If the domain is a tokenized NFT, the current NFT holder.
2. **SOL record V2.** Else, if a valid SOL record V2 exists, the address it points to.
3. **SOL record V1.** Else, if a valid SOL record V1 exists, the address it points to.
4. **Registry owner.** Else, `registry.owner`.

So `resolve()` is a strict superset of `registry.owner`: in the common case with no NFT and no SOL record, it returns the registry owner anyway; when a SOL record or NFT exists, it returns the correct, owner-intended target that `registry.owner` would miss.

### The rule

- "Where do I send funds / who is this name" -> `resolve(connection, name)`. Always.
- "Who administratively controls this name" -> `NameRegistryState.retrieve(...).registry.owner` (and check `nftOwner`).

Using `registry.owner` to route a payment will send funds to the wrong wallet whenever the owner has published a SOL record, which many active domains have.

## Function quick reference

| Goal | Function | Returns |
|------|----------|---------|
| Resolve name to funds target | `resolve(connection, name)` | `PublicKey` (SNS-IP-5 priority) |
| Derive domain account key (no RPC) | `getDomainKeySync(name)` | `{ pubkey, ... }` |
| Read registry owner (admin) | `NameRegistryState.retrieve(connection, domainKey)` | `{ registry, nftOwner }` |
| List a wallet's domain keys | `getAllDomains(connection, owner)` | `PublicKey[]` |
| List a wallet's domains with names | `getDomainKeysWithReverses(connection, owner)` | `[{ pubKey, domain }]` |
| Reverse a domain account to its name | `reverseLookup(connection, domainKey)` | `string` |
| Read a wallet's primary domain | `getPrimaryDomain(connection, owner)` | `{ domain, reverse, stale }` |
| Register a domain | `registerDomainNameV2(connection, name, space, buyer, buyerTokenAccount, mint, referrerKey?)` | instruction(s) |
| Create a subdomain | `createSubdomain(connection, "sub.parent.sol", owner)` | instruction(s) |
| Transfer a subdomain | `transferSubdomain(...)` | instruction(s) |
| Read a record (V2) | `getRecordV2(...)` / `getRecordV2Key(...)` | record data / key |

Deprecated aliases to avoid in new code: `getFavoriteDomain` (use `getPrimaryDomain`), `performReverseLookup` (use `reverseLookup`), V1 record helpers (use the V2 record API).

Version note: the table above is the v3 (3.0.x) shape, verified against the installed `@bonfida/spl-name-service@3.0.23` types. `registerDomainNameV2`'s argument order has shifted across major versions, so if you pin a different major, confirm the signature against `node_modules/@bonfida/spl-name-service/dist/*.d.ts`.
