# NTT: Native Token Transfers

Companion to the `wormhole` skill. NTT is the canonical multichain token standard: a token keeps **one canonical supply across chains** by burning on the source and minting on the destination, instead of the Token Bridge's lock-and-mint that produces a wrapped derivative. Use NTT when the token is **yours** and you want it native everywhere.

> NTT ships its own SDK and CLI on top of the core Wormhole SDK. Pin the version you install and check exact CLI subcommands and method names against its docs, since they evolve faster than the core SDK.

## Burn-and-mint vs lock-and-mint

```
Token Bridge (wrapped, lock-and-mint)
  source:      LOCK   N tokens in the bridge
  destination: MINT   N Wormhole-WRAPPED tokens (a derivative)
  result:      original supply locked + a wrapped copy elsewhere

NTT (canonical, burn-and-mint)
  source:      BURN   N tokens (supply on source drops by N)
  destination: MINT   N native tokens (supply on destination rises by N)
  result:      ONE canonical supply, just redistributed across chains
```

With the Token Bridge you receive `wormhole-wrapped TOKEN`, a distinct asset from the issuer's token. With NTT you receive the issuer's actual token, native on that chain. No wrapped fragmentation, no "which wrapped version is the real one" problem.

> NTT also supports a hub-and-spoke lock/mint variant for tokens that cannot be made burnable, but the canonical case, and the reason to choose NTT, is burn-and-mint with a single supply. Know which mode your deployment uses.

## When to choose NTT over the Token Bridge

| You are... | Use |
|------------|-----|
| Bridging an asset you do **not** issue (someone else's token, a blue chip) | Token Bridge (you get a wrapped version) |
| The **issuer** of the token, and you want it native and fungible on every chain | **NTT** |
| Just moving value by the cheapest route, mechanism irrelevant | An aggregator (`debridge`, `lifi`) |

NTT is a decision the token issuer makes about their token's cross-chain identity. It is not something an integrator improvises per transfer.

## What you deploy (this is the real work)

NTT is a deployment task before it is a transfer task. Per chain in scope:

- **NTT manager** contract for the token: owns the burn/mint authority and enforces rate limits. On Solana this is a program with the token's mint authority delegated to it; on EVM it is a manager contract.
- **Transceiver(s):** the piece that actually sends and receives the cross-chain message (the default rides the Wormhole Core Bridge; other transceivers exist).
- **Peer registration:** each chain's manager must register the others as peers so they accept each other's messages.
- **Rate limits:** inbound and outbound limits per chain, a safety valve against a compromised endpoint.

This is typically driven by the **NTT CLI** (deploy, configure, add-chain, set-peers, set rate limits) rather than hand-written calls. Check the CLI subcommands for the version you install.

## Transfer sketch (after deployment)

Once managers are deployed, registered as peers, and configured, a transfer is conceptually the same two-phase flow as the Token Bridge (initiate -> VAA -> redeem), but it burns on the source and mints canonically on the destination.

```ts
// Sketch of the NTT transfer shape. Fill in your deployed NTT config.
import { wormhole, signSendWait, Wormhole } from "@wormhole-foundation/sdk";
import solana from "@wormhole-foundation/sdk/solana";
import evm from "@wormhole-foundation/sdk/evm";

const wh = await wormhole("Testnet", [solana, evm]);
const src = wh.getChain("Solana");
const dst = wh.getChain("BaseSepolia");

// The NTT protocol is keyed by your deployed manager + token config.
const ntt = await src.getProtocol("Ntt", { ntt: /* your deployed NTT config */ {} });

// ntt.transfer(sender, amount, recipient, options) -> unsigned txs.
const recipient = Wormhole.chainAddress("BaseSepolia", recipientAddress);
const xfer = ntt.transfer(
  senderAddress,            // source signer address
  amountInBaseUnits,        // base units (use the amount helper + token decimals)
  recipient,
  { automatic: false },     // relayer vs manual
);

// Then: signSendWait on Solana -> wait for the VAA (same backoff as
// token-transfer.ts) -> redeem on the destination NTT manager.
// The supply moves; no wrapped token.
```

## Gotchas specific to NTT

- **Deployment first.** A transfer cannot work until managers exist and are peered on both ends. If a transfer reverts with an unknown-peer or not-registered error, the configuration is incomplete, not the transfer.
- **Rate limits gate transfers.** A transfer can be delayed or rejected if it exceeds the inbound/outbound rate limit on a chain. This is intended; raise the limit deliberately, do not work around it.
- **Mint authority must be delegated** to the NTT manager (burn-and-mint mode). If the manager cannot mint on the destination or burn on the source, the token's authority is not wired correctly.
- **Same two-phase wait** as any Wormhole transfer: source confirmed is not done; wait for the VAA, then redeem. See `../resources/programs-and-flow.md`.

## References

- NTT overview: https://wormhole.com/docs/build/contract-integrations/native-token-transfers/
- NTT SDK + CLI (pin versions on npm): the `@wormhole-foundation` NTT packages
- Token Bridge vs NTT comparison and the VAA lifecycle: `../resources/programs-and-flow.md`
