---
name: wormhole
description: Move tokens and arbitrary messages between Solana and other chains over the Wormhole protocol, including Native Token Transfers (NTT). Use when bridging assets Solana to EVM (or back), sending cross-chain messages, building a token that keeps one canonical supply across chains, fetching and redeeming a signed VAA, or wiring an automatic relayer. Wormhole is the underlying messaging protocol and canonical token standard, not a route aggregator. Keywords: Wormhole, cross-chain, bridge, NTT, Native Token Transfers, VAA, guardian, Token Bridge, Core Bridge, cross-chain messaging, Solana to EVM, wrapped token, mint and burn.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Wormhole on Solana

Build cross-chain transfers and generic messaging into and out of Solana over Wormhole: the Token Bridge (wrapped, lock-and-mint), Native Token Transfers (NTT, one canonical supply across chains), and the raw Core Bridge message layer underneath both. Covers initiating on Solana, the guardian-signed VAA lifecycle, and redeeming on the destination chain manually or through an automatic relayer.

## Overview

Wormhole is a generic message-passing protocol. A set of guardians observes a message emitted on a source chain and, once a supermajority signs it, produces a VAA (Verifiable Action Approval, sometimes written "Verified Action Approval"): a portable, signed attestation that the message happened. Anything built on Wormhole, token transfers included, is ultimately a VAA emitted on one chain and verified on another.

That makes Wormhole different in kind from `debridge` and `lifi`. Those are bridge or route aggregators: you ask for a quote, they pick a path, you sign once. Wormhole is the protocol primitive several such routes are built on. Reach for this skill when you need the protocol itself: the canonical wrapped-asset bridge, your own token deployed natively across chains, or raw cross-chain messages. For "just move value by the cheapest route," an aggregator is usually simpler; say so.

Three layers, from lowest to highest:

1. **Core Bridge** (`worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` on Solana) emits and verifies raw messages. Everything else sits on top.
2. **Token Bridge** (`wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb` on Solana) is lock-and-mint: lock the asset on the source chain, mint a Wormhole-wrapped representation on the destination. Use it to bridge assets you do not control (USDC-equivalents, blue chips) as wrapped tokens.
3. **NTT (Native Token Transfers)** is burn-and-mint for a token you own: burn on the source, mint on the destination, so one canonical supply moves across chains with no wrapped derivative. Use it when the token is yours and you want it native everywhere instead of a wrapped IOU.

A transfer is always two-phase and asynchronous: **initiate on the source**, wait for guardian quorum and source finality, then **redeem on the destination**. Funds are in flight and not spendable until redemption lands. This skill makes that lifecycle explicit so an agent waits correctly and never reports a half-finished transfer as done.

### When to use which

| Goal | Use | Why |
|------|-----|-----|
| Bridge an asset you do not issue (wrapped) | Token Bridge | Lock-and-mint produces a Wormhole-wrapped token on the destination. |
| Make your own token native on many chains | NTT | One canonical supply, burn-and-mint, no wrapped derivative. |
| Send arbitrary cross-chain data | Core Bridge / messaging | Lowest-level VAA emit and verify. |
| Cheapest route, do not care about mechanism | An aggregator (`debridge`, `lifi`) | Wormhole is the primitive, not the optimizer. |

## Instructions

The program IDs and package family below are stable. Pin the SDK version you install and check exact export names against its typings, since the SDK surface can shift across major releases.

### Step 0: Pin packages, IDs, and network

Before writing transfer code, pin the moving parts.

1. **SDK family.** The current unified TypeScript SDK is the `@wormhole-foundation/sdk` family: a meta package plus per-platform packages such as `@wormhole-foundation/sdk-solana` and `@wormhole-foundation/sdk-evm`. NTT has its own SDK and CLI on top. Pin the version you install (`npm view @wormhole-foundation/sdk version`).
2. **Program IDs (Solana):** Core Bridge `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth`, Token Bridge `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb`. These are the canonical mainnet deployments.
3. **Network.** Decide `"Mainnet"`, `"Testnet"`, or `"Devnet"` and use one network for both ends. The guardian set, contract addresses, and the wormholescan endpoint all differ by network. A VAA from one network never verifies on another.

**Success criterion:** You have the package family and version pinned, the source and destination chain contexts, and one network string used everywhere.

### Step 1: Initialize the SDK and get chain contexts

Construct the Wormhole instance with the platforms you need, then pull a `ChainContext` for each end.

```ts
import { wormhole } from "@wormhole-foundation/sdk";
import solana from "@wormhole-foundation/sdk/solana";
import evm from "@wormhole-foundation/sdk/evm";

const wh = await wormhole("Testnet", [solana, evm]);

const src = wh.getChain("Solana");
const dst = wh.getChain("Sepolia"); // or "Ethereum", "BaseSepolia", etc.
```

From a chain context you obtain the protocol module you need: a Token Bridge (`await src.getTokenBridge()`), the Core Bridge (`await src.getWormholeCore()`) for raw messages, or an NTT protocol. Exact getter names are version-stable in the unified SDK; check the installed typings if a getter is missing.

**Success criterion:** `wh` is built on one network, and you hold a source and destination `ChainContext`.

### Step 2: Pick the model: Token Bridge, NTT, or raw message

Decide before writing the initiate call, because the redeem path differs.

- **Token Bridge (wrapped):** bridging an asset you do not issue. Source locks, destination mints a Wormhole-wrapped token. If a wrapped version does not yet exist on the destination, it must be **attested** once first (a one-time `createAttestation` -> VAA -> `submitAttestation` so the destination learns the token's metadata; the SDK route helper handles this automatically if you use it).
- **NTT (canonical):** the token is yours and you want native supply on each chain. Requires NTT manager (and transceiver) contracts deployed and configured on every chain in scope. You do not improvise this inside a transfer; see `examples/concepts-ntt.md`.
- **Raw message:** no token movement, just data. Emit via the Core Bridge, fetch the VAA, verify and act on the destination.

**Success criterion:** You have chosen one model and, for Token Bridge, you know whether the destination wrapped asset already exists or needs a one-time attestation.

### Step 3: Initiate the transfer on Solana

Build and sign the source-side transaction. Two routing styles:

- **Route abstraction (recommended for app flows):** the SDK's `routes` resolver plans, builds, signs, and can track the legs for you. Prefer this when you want the SDK to handle the wrapped-asset lookup, the relayer choice, and the redeem leg.
- **Protocol-level (explicit):** call the Token Bridge module directly to produce the source instructions, sign with a Solana signer, and send. This gives you the source transaction signature, which is the handle you use to find the VAA.

A Solana initiate, protocol level, looks like: get the Token Bridge from the source chain, call `tokenBridge.transfer(sender, recipient, token, amount)` to get an unsigned-tx generator, then `signSendWait(src, xfer, signer)` with a `SignAndSendSigner` wrapping your keypair. Capture the returned `TransactionId`. See `examples/token-transfer.ts` for the full shape.

Set `automatic: true` if you want a relayer to deliver and redeem on the destination (you pay a relayer fee, often a small native-gas drop-off too). Set it `false` (or use the manual path) to fetch and redeem the VAA yourself.

**Success criterion:** The Solana source transaction is confirmed and you hold its signature (and the emitter address plus sequence, or a `TransactionId` the SDK can resolve to them).

### Step 4: Wait for the signed VAA

This is the wait people forget. After the source transaction confirms, the guardians still need to observe it and reach quorum, and the source chain must reach the finality the guardians require. Until both happen, no VAA exists and redemption will fail.

- Use `wh.getVaa(txid, "TokenBridge:Transfer", timeoutMs)`, keyed by the source `TransactionId`; you can also fetch by `(emitterChain, emitterAddress, sequence)`.
- It will not be available instantly. Poll with a sane timeout and backoff, or use the route/transfer tracker if you took the route path. Solana finality is fast, but the guardian observation plus quorum is not zero; some destinations also impose extra confirmations.
- Do not treat "source tx confirmed" as "transfer done." The funds are in flight until Step 5 lands.

**Success criterion:** You hold the signed VAA bytes (guardian quorum reached). If the fetch times out, you report "in flight, VAA not yet available" and the source `TransactionId` for later retry, never "failed."

### Step 5: Redeem on the destination chain

Complete the transfer on the destination so the wrapped mint (Token Bridge) or canonical mint (NTT) actually happens.

- **Automatic relayer:** if you set `automatic: true`, a relayer submits the VAA for you; you only poll for completion. Confirm arrival on the destination before reporting success.
- **Manual:** submit the VAA to the destination Token Bridge / NTT manager (`tokenBridge.redeem(recipient, vaa)`), signed by a destination signer that pays gas. A VAA is idempotent: re-submitting an already-redeemed VAA fails or no-ops rather than double-minting. This makes a stuck redeem safe to retry, unlike a generic resend.

**Success criterion:** The destination redeem transaction is confirmed and the recipient holds the wrapped or canonical token. Only now is the transfer complete; report the source and destination signatures together.

### Step 6: Report the full two-phase result

State both legs explicitly: source chain + signature, VAA status, destination chain + signature, and the token form the recipient received (Wormhole-wrapped vs canonical/NTT). If you stopped at Step 4 because the VAA was not yet available, say so and hand back the source `TransactionId` so the redeem can finish later. Never collapse a two-phase transfer into a single "done."

**Success criterion:** The report names both phases and the recipient's token form, with no ambiguity about whether redemption happened.

## Examples

### Example 1: USDC-equivalent, Solana to Sepolia, manual VAA redeem

User: "Bridge a wrapped test token from Solana devnet/testnet to an address on Sepolia."

The agent runs `examples/token-transfer.ts`:

1. **Pin** packages and versions (`npm view @wormhole-foundation/sdk version`), program IDs, network `"Testnet"` for both ends.
2. **Init:** `wormhole("Testnet", [solana, evm])`; `src = wh.getChain("Solana")`, `dst = wh.getChain("Sepolia")`.
3. **Model:** Token Bridge (asset not issued by us), so it is wrapped. Check whether the wrapped version exists on Sepolia; if not, do the one-time attestation first.
4. **Initiate on Solana:** Token Bridge transfer instructions for the token, amount, `"Sepolia"`, recipient; sign with the Solana keypair signer; capture the source signature.
5. **Wait for VAA:** poll `wh.getVaa(...)` keyed by the source `TransactionId` with backoff until quorum; if it times out, return "in flight" plus the `TransactionId`.
6. **Redeem on Sepolia:** submit the VAA to the destination Token Bridge with an EVM signer that pays gas; confirm the mint.
7. **Report:** Solana sig + Sepolia sig + "recipient holds Wormhole-wrapped TOKEN on Sepolia."

### Example 2: Automatic relayer, no manual redeem

User: "Same transfer, but I do not want to run the redeem leg myself."

Set `automatic: true` on the transfer (route or protocol path). A relayer delivers and redeems on the destination; the agent only polls for completion and confirms arrival before reporting success. Trade-off: a relayer fee (and often a small destination-gas drop-off) in exchange for not needing a funded destination signer. Check that a relayer is supported for that source/destination pair before relying on the automatic path.

### Example 3: Your own token native across chains (NTT)

User: "I have an SPL token and want it native on Base too, not a wrapped IOU."

This is NTT, not Token Bridge. It is a deployment task before it is a transfer task: deploy and configure NTT manager (and transceiver) contracts on each chain, register peers, and set rate limits. Once configured, a transfer burns on the source and mints on the destination, preserving one canonical supply. The agent should walk the user through `examples/concepts-ntt.md` and the NTT CLI rather than improvising manager calls inside an ordinary transfer. Flag clearly that this requires on-chain deployment and is not a one-call operation.

## Guidelines

- **DO** pin the SDK version on npm before sending value. The exact export names are the thing most likely to drift between major releases; check them against the installed typings if a call is missing.
- **DO** treat every transfer as two-phase: initiate, wait for VAA, redeem. Funds are in flight until redemption lands.
- **DO** wait for guardian quorum and source finality before attempting redeem. Poll with backoff and a timeout; report "in flight" on timeout, not "failed."
- **DO** pick the model deliberately: Token Bridge for wrapped assets you do not issue, NTT for your own canonical token, Core Bridge for raw messages.
- **DO** keep one network (`Mainnet`/`Testnet`/`Devnet`) on both ends; a VAA does not cross networks.
- **DON'T** report "source transaction confirmed" as a completed transfer. It is half done until the destination redeem confirms.
- **DON'T** reach for Wormhole when the user only wants the cheapest route; an aggregator (`debridge`, `lifi`) is simpler. Use Wormhole when they need the protocol, NTT, or raw messaging specifically.
- **DON'T** improvise NTT manager deployment inside a transfer; NTT requires deployed and configured contracts on every chain in scope.
- **DON'T** forget the one-time attestation when a Token Bridge wrapped asset does not yet exist on the destination.
- **DON'T** assume redeem failed because a VAA "already redeemed" error came back; that means a prior redeem already succeeded. Check the destination balance.

## Common Errors

| Symptom | Cause | Solution |
|---------|-------|----------|
| VAA fetch returns not-found / 404 right after source tx | Guardians have not reached quorum or source finality yet. | Poll with backoff; this is expected latency, not a failure. Report "in flight" on timeout with the source `TransactionId`. |
| Redeem reverts: "no wrapped asset" / unknown token on destination | Token Bridge wrapped representation was never attested on the destination. | Do the one-time attestation (`createAttestation` -> VAA -> `submitAttestation`) first, then transfer. |
| Redeem fails with "already completed" / "already redeemed" | The VAA was already redeemed (relayer or a prior manual attempt). | Not an error: the transfer is done. Verify the destination balance. |
| VAA does not verify on the destination | Source and destination are on different networks (Mainnet vs Testnet), or the guardian set differs. | Use one network for both ends; re-fetch the VAA from the matching network's endpoint. |
| Import or method-not-found at build time | SDK version differs from the export names used. | Check the installed version (`npm view @wormhole-foundation/sdk version`) and match the exact exports against its typings. |
| Wrong on-chain program invoked / account mismatch on Solana | Stale or mistyped Core/Token Bridge program ID. | Use `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` (Core) and `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb` (Token Bridge). |
| Automatic transfer never redeems | No relayer supports that source/destination pair, or the relayer fee was insufficient. | Fall back to manual VAA fetch + redeem, or confirm relayer support and fee for the route. |

## References

- `resources/programs-and-flow.md` - Solana program IDs (Core Bridge, Token Bridge), the VAA lifecycle stage by stage, the two-phase wait model, and Token Bridge (wrapped) vs NTT (canonical) compared.
- `examples/token-transfer.ts` - end-to-end Solana-to-EVM transfer: init, initiate on Solana, fetch the VAA with backoff, redeem on EVM, using the unified SDK's `transfer` / `signSendWait` / `getVaa` / `redeem` calls.
- `examples/concepts-ntt.md` - what NTT is, burn-and-mint vs lock-and-mint, when to choose it over the Token Bridge, the manager/transceiver pieces you deploy, and a flagged transfer sketch.
- Wormhole docs: https://wormhole.com/docs
- Wormhole TypeScript SDK (confirm package + version on npm): https://www.npmjs.com/package/@wormhole-foundation/sdk
- Native Token Transfers (NTT): https://wormhole.com/docs/build/contract-integrations/native-token-transfers/
- VAA explorer (network-specific): https://wormholescan.io
