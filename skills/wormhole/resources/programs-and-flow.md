# Wormhole: programs, VAA lifecycle, and the two transfer models

Reference data for the `wormhole` skill. Everything an integration looks up repeatedly: Solana program IDs, the stages a VAA passes through, the two-phase wait model, and how the wrapped (Token Bridge) and canonical (NTT) models differ.

> The program IDs below are the canonical Solana mainnet deployments and are stable. Pin the SDK version on npm at build time.

## Solana program IDs (mainnet)

| Layer | Program ID | Role |
|-------|------------|------|
| Core Bridge | `worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth` | Emits and verifies raw cross-chain messages. The base layer; everything else sits on it. |
| Token Bridge | `wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb` | Lock-and-mint token transfers (wrapped assets). Calls into the Core Bridge to emit the transfer message. |
| NTT manager | Per-token, deployed by the token owner | Burn-and-mint for a specific canonical token. Not a single shared program; one manager (plus transceivers) per token deployment. |

Testnet and devnet use different program IDs and a different guardian set. Never mix networks: a VAA produced under one network's guardian set will not verify under another's.

## What a VAA is

A VAA (Verifiable Action Approval) is a guardian-signed attestation that a message was emitted on a source chain. It carries:

- the **emitter** (chain id + emitter address, e.g. the Token Bridge on Solana),
- a **sequence** number (monotonic per emitter),
- the **payload** (for a token transfer: token, amount, recipient, destination chain),
- the **guardian signatures** (a supermajority of the guardian set).

The same VAA is portable: any chain that knows the guardian set can verify it. A token transfer is just a VAA whose payload the destination Token Bridge (or NTT manager) knows how to act on. The triple `(emitterChain, emitterAddress, sequence)` uniquely identifies a VAA and is how you fetch it if you did not keep the source `TransactionId`.

## VAA lifecycle, stage by stage

```
[1] Source initiate        Solana tx calls Token Bridge / NTT / Core Bridge.
                           A message is emitted via the Core Bridge.
        |
        v
[2] Source finality        The source chain reaches the finality the guardians
                           require for this message. (Solana is fast, but not zero.)
        |
        v
[3] Guardian observation   Guardians see the emitted message and each sign it.
        |
        v
[4] Quorum -> VAA          Once a supermajority has signed, the signed VAA exists
                           and is fetchable. THIS IS THE WAIT people skip.
        |
        v
[5] Destination redeem     Submit the VAA to the destination Token Bridge / NTT
                           manager. Wrapped mint or canonical mint happens here.
        |
        v
[6] Complete               Recipient holds the token. Only now is the transfer done.
```

Stages 1 and 5 are the two transactions you sign (or that a relayer signs for you). Stages 2 to 4 are latency you wait through, not actions you take. Between stage 1 and stage 5 the funds are **in flight**: locked or burned on the source, not yet minted on the destination, and not spendable.

### The two-phase wait model (do not skip)

- "Source transaction confirmed" is **not** "transfer complete." It is stage 1 of 6.
- The VAA does not exist the instant the source tx confirms. You must poll (with backoff and a timeout) until quorum, then redeem.
- If your VAA poll times out, the correct report is "in flight, VAA not yet available," handing back the source `TransactionId` (or the emitter/sequence) so the redeem can finish later. It is **not** a failure.
- A VAA is **idempotent** at redemption: submitting an already-redeemed VAA fails or no-ops rather than double-minting. So a redeem that "already completed" means a prior redeem (often a relayer) already succeeded; check the destination balance instead of retrying blindly.

### Manual vs relayer redemption

| Path | Who submits the VAA on the destination | You need | Cost |
|------|----------------------------------------|----------|------|
| Manual | You, with a destination signer | A funded destination signer that pays gas | Just destination gas |
| Automatic relayer | A relayer, on your behalf | Nothing on the destination side; you only poll | A relayer fee, often plus a small destination native-gas drop-off |

Set the transfer's `automatic` flag to choose. Automatic relaying is convenient for app flows where the recipient has no gas on the destination; manual gives full control and avoids relayer fees. Not every source/destination pair has relayer support; if automatic never redeems, fall back to manual.

## Token Bridge (wrapped) vs NTT (canonical)

Two different models for moving a token. Pick by who issues the token and whether you want a wrapped derivative or one native supply.

| | Token Bridge (wrapped) | NTT (Native Token Transfers, canonical) |
|---|---|---|
| Mechanism | Lock on source, mint a Wormhole-wrapped token on destination | Burn on source, mint native token on destination |
| Resulting asset | A Wormhole-wrapped representation (a derivative) | The same canonical token, native on each chain |
| Total supply | Original locked + wrapped copies | One canonical supply across all chains |
| Who uses it | Anyone bridging an asset they do **not** issue | The **token issuer**, for their own token |
| Setup | None beyond a one-time per-token attestation on each destination | Deploy and configure NTT manager (+ transceivers) on every chain, register peers, set rate limits |
| Best for | Bridging blue chips / stablecoin-equivalents as wrapped assets | Making your token native multichain with no wrapped IOU |

### When to choose which

- **You do not issue the token** (you are moving someone else's asset): Token Bridge. You will receive a Wormhole-wrapped version on the destination. If no wrapped version exists there yet, attest it once first.
- **You issue the token** and want it to be the same native asset everywhere, not a wrapped derivative: NTT. This is a deployment effort up front (manager + transceiver contracts per chain) in exchange for a single canonical supply and no wrapped fragmentation.
- **You only want the cheapest hop and do not care about the mechanism:** consider an aggregator (`debridge`, `lifi`) instead. Wormhole is the protocol primitive, not the route optimizer.

### One-time attestation (Token Bridge only)

Before a Wormhole-wrapped version of a token can be minted on a destination chain, that chain must learn the token's metadata. This is a one-time `createAttestation` on the source (which emits its own VAA) followed by `submitAttestation` on the destination. After that, transfers of that token to that destination just work.
