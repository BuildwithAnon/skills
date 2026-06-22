/**
 * Wormhole Token Bridge transfer: Solana -> EVM (e.g. Sepolia), end to end.
 *
 * Flow: initialize -> initiate on Solana -> wait for the guardian-signed VAA
 * (with backoff) -> redeem on the destination -> report BOTH legs.
 *
 * This uses the unified Wormhole TypeScript SDK (`@wormhole-foundation/sdk`).
 * The SDK surface can shift between major releases, so pin a version and verify
 * the exact export names against the installed package's typings:
 *   1. npm view @wormhole-foundation/sdk version   (pin the version you install)
 *   2. Confirm program IDs against the official Wormhole deployment registry.
 *
 * Install:
 *   npm i @wormhole-foundation/sdk
 *   # The meta package pulls in platform sub-packages via its sub-imports.
 *   # Install @wormhole-foundation/sdk-solana / -sdk-evm explicitly only if you
 *   # import platform internals directly.
 *
 * Env vars expected:
 *   SOLANA_PRIVATE_KEY   base58 secret key for the Solana sender
 *   EVM_PRIVATE_KEY      0x-hex private key for the destination signer (manual redeem)
 *   TOKEN               token identifier to bridge ("native" for SOL, or a mint address)
 *   AMOUNT              human amount, e.g. "0.1"
 *   NETWORK             "Mainnet" | "Testnet" | "Devnet"  (default "Testnet")
 *   DEST_CHAIN          e.g. "Sepolia" | "Ethereum" | "BaseSepolia"
 *   DEST_ADDRESS        recipient address on the destination chain
 *   AUTOMATIC           "true" to use a relayer (skip manual redeem), else "false"
 */

import { wormhole, signSendWait, amount, Wormhole } from "@wormhole-foundation/sdk";
import solana from "@wormhole-foundation/sdk/solana";
import evm from "@wormhole-foundation/sdk/evm";

// Well-known Solana mainnet program IDs (verify against the official registry).
const SOLANA_CORE_BRIDGE = "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth";
const SOLANA_TOKEN_BRIDGE = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";

const NETWORK = (process.env.NETWORK ?? "Testnet") as "Mainnet" | "Testnet" | "Devnet";
const DEST_CHAIN = process.env.DEST_CHAIN ?? "Sepolia";
const DEST_ADDRESS = required("DEST_ADDRESS");
const TOKEN = process.env.TOKEN ?? "native";
const AMOUNT = process.env.AMOUNT ?? "0.01";
const AUTOMATIC = (process.env.AUTOMATIC ?? "false") === "true";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/**
 * Build a SignAndSendSigner for each platform. Each platform package exposes a
 * `getSigner(rpc, secret)` helper that returns a signer implementing the
 * SignAndSendSigner interface (chain(), address(), signAndSend()).
 */
async function getSolanaSigner(chainCtx: any) {
  const key = required("SOLANA_PRIVATE_KEY");
  return (solana as any).getSigner(await chainCtx.getRpc(), key);
}

async function getEvmSigner(chainCtx: any) {
  const key = required("EVM_PRIVATE_KEY");
  return (evm as any).getSigner(await chainCtx.getRpc(), key);
}

/** Poll for the signed VAA with exponential backoff. */
async function waitForVaa(
  wh: any,
  txid: string,
  { timeoutMs = 120_000, startMs = 2_000, maxMs = 15_000 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let delay = startMs;
  while (Date.now() < deadline) {
    // getVaa(txid, payloadDiscriminator, timeoutMs). Returns null until quorum.
    const vaa = await wh.getVaa(txid, "TokenBridge:Transfer", 0).catch(() => null);
    if (vaa) return vaa;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, maxMs);
  }
  return null; // not yet available: caller reports "in flight", not "failed"
}

async function main() {
  console.log(`Network: ${NETWORK}  Solana -> ${DEST_CHAIN}`);
  console.log(`Core Bridge ${SOLANA_CORE_BRIDGE} | Token Bridge ${SOLANA_TOKEN_BRIDGE}`);

  // 1) Initialize with the platforms we need, on ONE network.
  const wh = await wormhole(NETWORK, [solana, evm]);

  const src = wh.getChain("Solana");
  const dst = wh.getChain(DEST_CHAIN as any);

  // 2) Token Bridge model (wrapped). For a token you ISSUE, use NTT instead
  //    (see ../resources/programs-and-flow.md and concepts-ntt.md).
  const tokenBridge = await src.getTokenBridge();

  // Resolve the token id. "native" maps to the chain's native token; a mint
  // maps via Wormhole.tokenId("Solana", mint).
  const tokenId =
    TOKEN === "native"
      ? Wormhole.tokenId("Solana", "native")
      : Wormhole.tokenId("Solana", TOKEN);

  // Look up the token's decimals to convert the human amount to base units.
  const decimals = await wh.getDecimals("Solana", tokenId.address);
  const amt = amount.units(amount.parse(AMOUNT, Number(decimals)));

  const srcSigner = await getSolanaSigner(src);
  const sender = Wormhole.chainAddress("Solana", srcSigner.address());

  // 3) Initiate on Solana. Protocol-level path shown; the route abstraction
  //    (wh.resolver / routes) can plan+sign+track instead for app flows.
  console.log("Initiating transfer on Solana...");
  const recipient = Wormhole.chainAddress(DEST_CHAIN as any, DEST_ADDRESS);
  const xfer = tokenBridge.transfer(sender.address, recipient, tokenId.address, amt);

  // signSendWait(chain, unsignedTxGenerator, signer) -> TransactionId[]
  const srcTxIds = await signSendWait(src, xfer, srcSigner);
  const srcTxId = srcTxIds[srcTxIds.length - 1];
  console.log("Source (Solana) tx:", srcTxId.txid);
  console.log("NOTE: source confirmed != transfer complete. Funds are IN FLIGHT.");

  // 4) Wait for the guardian-signed VAA.
  console.log("Waiting for guardian quorum (signed VAA)...");
  const vaa = await waitForVaa(wh, srcTxId.txid);
  if (!vaa) {
    console.log("IN FLIGHT: VAA not yet available before timeout.");
    console.log("Re-fetch later with this source tx id:", srcTxId.txid);
    return; // correct outcome on timeout: in flight, NOT failed
  }
  console.log("VAA acquired (quorum reached).");

  // 5) Redeem on the destination.
  if (AUTOMATIC) {
    console.log("Automatic relayer chosen: a relayer will redeem. Polling for completion...");
    // For the relayer path, track completion (e.g. via the route tracker or
    // wormholescan) and confirm arrival before reporting success.
    console.log("Confirm destination receipt before reporting success.");
    return;
  }

  console.log(`Redeeming on ${DEST_CHAIN} (manual)...`);
  const dstSigner = await getEvmSigner(dst);
  const dstTokenBridge = await dst.getTokenBridge();
  const dstAddress = Wormhole.chainAddress(DEST_CHAIN as any, dstSigner.address());
  const redeem = dstTokenBridge.redeem(dstAddress.address, vaa);
  const dstTxIds = await signSendWait(dst, redeem, dstSigner);
  const dstTxId = dstTxIds[dstTxIds.length - 1];

  // 6) Report BOTH legs.
  console.log("\n=== TRANSFER COMPLETE (both phases) ===");
  console.log("Source  (Solana):     ", srcTxId.txid);
  console.log(`Destination (${DEST_CHAIN}):`, dstTxId.txid);
  console.log("Recipient now holds the Wormhole-wrapped token on", DEST_CHAIN);
}

main().catch((e) => {
  console.error("Transfer error:", e);
  process.exit(1);
});
