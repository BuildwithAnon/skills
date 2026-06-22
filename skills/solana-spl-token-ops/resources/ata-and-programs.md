# Program IDs, ATA Derivation, Auto-Detection, and Rent

All addresses are identical on devnet, testnet, and mainnet-beta.

## Core program IDs

| Program | Address | `@solana/spl-token` export |
|---------|---------|----------------------------|
| Classic SPL Token | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` | `TOKEN_PROGRAM_ID` |
| Token-2022 (Token Extensions) | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` | `TOKEN_2022_PROGRAM_ID` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` | `ASSOCIATED_TOKEN_PROGRAM_ID` |
| Wrapped SOL (WSOL) mint, classic | `So11111111111111111111111111111111111111112` (9 decimals) | `NATIVE_MINT` |
| Wrapped SOL (WSOL) mint, Token-2022 | `9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP` (9 decimals) | `NATIVE_MINT_2022` |

The classic `NATIVE_MINT` is a classic Token program mint: wrap, sync, and close it with `TOKEN_PROGRAM_ID`. WSOL also exists under Token-2022 as `NATIVE_MINT_2022`; do not assume the native mint is only the classic one. If a flow uses Token-2022 WSOL, derive its ATA, sync, and close with `TOKEN_2022_PROGRAM_ID`. The two are distinct mints with distinct ATAs.

Always pass the token program id explicitly. Some older helper signatures default to the classic Token program, which silently produces the wrong address or sends to the wrong program for a Token-2022 mint.

## Auto-detect which program owns a mint

A mint account's `owner` field is the token program that created it. This is the only reliable way to know whether to use classic or Token-2022. Read it before acting on any mint you did not create.

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

async function getTokenProgramId(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error(`not a token mint, owner is ${info.owner.toBase58()}`);
}
```

Thread the returned `programId` through every downstream call: ATA derivation, `getMint`, `transferChecked`, `mintTo`, `burnChecked`, and `closeAccount`. Mixing the two programs is the most common SPL bug.

## ATA derivation

The Associated Token Account is a PDA over `[owner, tokenProgramId, mint]` under the ATA program. The token program id is part of the seeds, so a Token-2022 mint derives a different ATA than a classic mint with the same owner.

```ts
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ata = getAssociatedTokenAddressSync(
  mint,
  owner,
  allowOwnerOffCurve, // false for normal wallets; true only when owner is a PDA
  programId,          // the DETECTED token program id, not a hardcoded default
  ASSOCIATED_TOKEN_PROGRAM_ID
);
```

Rules:

- Pass the detected `programId`. The wrong one derives a valid-looking but unrelated address, leading to `TokenAccountNotFoundError` when you read it.
- `allowOwnerOffCurve` must be `true` when the owner is a PDA (for example a program vault or escrow authority). Leave it `false` for ordinary wallets.
- Derivation is deterministic and offline. It does not tell you whether the account exists on chain; check with `getAccountInfo` or just create it idempotently.

## Idempotent ATA creation (safe default)

Use the idempotent instruction so a re-run, retry, or concurrent transaction does not fail when the ATA already exists.

```ts
import { createAssociatedTokenAccountIdempotentInstruction, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

const ix = createAssociatedTokenAccountIdempotentInstruction(
  payer,      // pays the rent
  ata,        // derived above
  owner,      // who the account belongs to
  mint,
  programId,
  ASSOCIATED_TOKEN_PROGRAM_ID
);
```

The non-idempotent `createAssociatedTokenAccountInstruction` throws "account already in use" if the ATA exists. Prefer the idempotent form unless you specifically want to fail when an account already exists.

### Instruction vs the one-call convenience

`getOrCreateAssociatedTokenAccount(connection, payer, mint, owner, allowOwnerOffCurve, commitment, options, programId, ASSOCIATED_TOKEN_PROGRAM_ID)` is a one-call helper that derives the ATA, creates it if missing, and returns the parsed `Account`. It sends its own transaction, so it needs `payer` as a signer and cannot be folded into another transaction.

- Use `getOrCreateAssociatedTokenAccount` for a quick "make sure this exists and give me the account" step.
- Use `createAssociatedTokenAccountIdempotentInstruction` when you want to batch the ATA creation into the same transaction as the transfer (one signature, one fee, atomic). The instruction does not send anything by itself; you add it to your transaction.

### Off-curve ATA: a program vault (PDA owner)

A PDA is derived off the ed25519 curve, so deriving its ATA with the default `allowOwnerOffCurve = false` throws `TokenOwnerOffCurveError`. Pass `true` for any PDA owner (a program vault, escrow authority, or market account):

```ts
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

// the vault authority your program signs for with invoke_signed
const [vaultPda] = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), market.toBuffer()],
  myProgramId
);

const vaultAta = getAssociatedTokenAddressSync(
  mint,
  vaultPda,
  true, // allowOwnerOffCurve: REQUIRED because the owner is a PDA
  programId,
  ASSOCIATED_TOKEN_PROGRAM_ID
);
```

Create it idempotently like any ATA; a normal wallet pays the rent, and the PDA's program authorizes later spends with `invoke_signed`. Forgetting `allowOwnerOffCurve = true` for a PDA is a common real bug.

## Reading balances

For a single account, two paths:

```ts
import { getAccount } from "@solana/spl-token";

// raw bigint of base units
const raw = (await getAccount(connection, ata, "confirmed", programId)).amount;

// or one RPC call returning amount + decimals + a formatted string
const bal = await connection.getTokenAccountBalance(ata);
// bal.value: { amount: "1500000", decimals: 6, uiAmountString: "1.5" }
```

To list every token a wallet holds, query by owner and program id. A Token-2022 holding does not appear under `TOKEN_PROGRAM_ID`, so when you do not know which program a wallet's tokens use, query both:

```ts
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const classic = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
const t22 = await connection.getTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID });
// classic.value and t22.value are arrays of { pubkey, account }; pass parsed:true variant
// (getParsedTokenAccountsByOwner) if you want decoded amounts without unpacking.
```

`getTokenAccountBalance` and `getTokenAccountsByOwner` are `Connection` methods from `@solana/web3.js`, not `@solana/spl-token` exports. For interest-bearing or scaled-UI mints the raw `amount` is not the displayed balance; convert with `amountToUiAmount` / `uiAmountToAmount` (see `token-2022-gotchas.md`) rather than multiplying by `10 ** decimals` in floats.

## Rent and costs

- A token account needs about **0.00204 SOL** of rent-exemption (165 bytes for a classic account; Token-2022 accounts with extensions need more). The payer of the ATA creation pays this.
- Closing an **empty** token account returns that rent to the destination via `createCloseAccountInstruction`. The token balance must be zero first (transfer out or burn), except for WSOL where closing also unwraps the balance to lamports.
- Each transaction also costs a base fee (about 0.000005 SOL per signature) plus any priority fee.
- Budget about 0.00204 SOL per ATA you create for someone, plus transaction fees, and leave headroom when wrapping SOL so the wrap plus fees do not exceed the balance.

## Cluster notes

- Devnet RPC: `https://api.devnet.solana.com`. Airdrop with `connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL)` or `solana airdrop 2`.
- Mainnet: use a paid provider (Helius, QuickNode, Triton) for production; the public mainnet endpoint is rate limited.
- Always run the flow on devnet first, then promote to mainnet with a funded keypair loaded from an env var.
