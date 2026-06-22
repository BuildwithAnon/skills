---
name: solana-durable-nonce
description: Create and use Solana durable nonce accounts so a transaction stays valid indefinitely instead of expiring with a recent blockhash. Use when a transaction must be signed now and submitted much later, when collecting signatures over time, or when the normal ~60 to 90 second blockhash window is too short. Covers offline signing, cold/hardware wallets, multisig signature collection, scheduled or queued transactions, and any flow where the signer and the sender are separated in time. Keywords: durable nonce, offline signing, nonce account, delayed signing, advanceNonce, nonceInitialize, NonceAccount, BlockhashNotFound on a pre-signed tx, hardware wallet signing, multisig over time.
metadata:
  author: "BuildwithAnon"
  version: "1.0.0"
---

# Solana Durable Nonce

A procedure for replacing a transaction's expiring recent blockhash with a durable nonce, so the transaction can be signed at one time and submitted at a much later time without hitting `BlockhashNotFound`. Covers creating a nonce account, reading its stored value, building a transaction against it, and the operational rules (advance-first instruction, stored-nonce-as-blockhash, authority-only mutation, single-use-per-advance) that make durable nonces work and the mistakes that silently break them.

## Overview

A normal Solana transaction carries a `recentBlockhash` that the cluster only accepts for a short window (roughly 150 slots, about 60 to 90 seconds). After that window the transaction is rejected with `BlockhashNotFound` and must be rebuilt and re-signed with a fresh blockhash. That is fine for an online wallet that signs and sends in one breath. It is a wall for any flow where signing and sending are separated in time:

- **Offline / air-gapped signing.** Build and sign on a machine with no network, carry the signed bytes to an online machine, submit. The trip takes longer than the blockhash window.
- **Hardware / cold wallets.** Confirming on a device, especially a multisig device, can take minutes.
- **Multisig signature collection.** Gathering N signatures from N parties over hours or days. Every party must sign the same message, which means the same blockhash, which cannot be a normal recent blockhash that expires before the last party signs.
- **Scheduled / queued transactions.** Pre-sign now, release on a condition or at a future time.

A **durable nonce** solves this. A nonce account is an on-chain account that stores a single durable blockhash (the "nonce"). A transaction can use that stored value as its `recentBlockhash` instead of a fresh one, and the cluster will accept it at any future time, as long as the nonce has not been advanced since. The nonce stays the same until exactly one transaction successfully uses it; that transaction advances the nonce to a new value, which invalidates any other transaction that was built against the old value. So a durable nonce gives you an unlimited-lifetime blockhash that can be spent exactly once.

The mechanics live in `SystemProgram`'s nonce instructions and the `NonceAccount` helper from `@solana/web3.js`. The rest of this skill is the exact sequence and the four rules that the system enforces.

This skill is for building and operating durable-nonce flows. If a pre-signed transaction fails at submission time, diagnose it with the `solana-tx-doctor` skill; a `BlockhashNotFound` on a transaction that was supposed to use a durable nonce almost always means one of the rules below was broken.

## Instructions

### Step 1: Decide whether you actually need a durable nonce

A durable nonce adds an on-chain account, rent, and an extra instruction on every transaction. Use it only when signing and submission are genuinely separated in time, or when multiple parties must sign one fixed message over a long period. If you sign and send within the same short-lived process and a normal `getLatestBlockhash` is good enough, do not introduce a nonce account.

**Success criterion:** You can name the specific time separation (offline trip, hardware confirmation, multisig collection, scheduled release) that the durable nonce is solving. If you cannot, use a normal recent blockhash.

### Step 2: Create and initialize the nonce account

A nonce account is a system-owned account of a fixed size that must be rent-exempt. Creating it is two instructions in one transaction:

1. `SystemProgram.createAccount` with `space: NONCE_ACCOUNT_LENGTH` and `lamports` equal to the rent-exemption minimum for that size, owned by `SystemProgram.programId`.
2. `SystemProgram.nonceInitialize({ noncePubkey, authorizedPubkey })`, which writes the first durable nonce into the account and records the authority.

The nonce account needs its own keypair (it is a new account being created), and both the fee payer and that new account keypair must sign the creation transaction. The `authorizedPubkey` is the only key that will later be allowed to advance, withdraw from, or re-authorize the nonce; choose it deliberately (often the same wallet that will sign the durable transactions).

```ts
import {
  Connection, Keypair, Transaction, SystemProgram, NONCE_ACCOUNT_LENGTH,
} from "@solana/web3.js";

const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);

const tx = new Transaction().add(
  SystemProgram.createAccount({
    fromPubkey: payer.publicKey,
    newAccountPubkey: nonceAccount.publicKey,
    lamports: rent,
    space: NONCE_ACCOUNT_LENGTH,
    programId: SystemProgram.programId,
  }),
  SystemProgram.nonceInitialize({
    noncePubkey: nonceAccount.publicKey,
    authorizedPubkey: nonceAuthority.publicKey,
  }),
);
// signers: payer (fee) AND nonceAccount (new account being created)
```

Send this once and keep the nonce account public key. See `examples/create-nonce-account.ts` for the full runnable flow including confirmation.

**Success criterion:** The transaction confirms, and a follow-up `getAccountInfo(noncePubkey)` returns a non-null account owned by the System Program with `NONCE_ACCOUNT_LENGTH` bytes of data.

### Step 3: Read the stored nonce

Before building a durable transaction, fetch the account and decode it. The stored durable blockhash is what you will use as the transaction's `recentBlockhash`.

```ts
import { NonceAccount } from "@solana/web3.js";

const accountInfo = await connection.getAccountInfo(noncePubkey);
if (!accountInfo) throw new Error("nonce account not found");
const nonceAccount = NonceAccount.fromAccountData(accountInfo.data);

const storedNonce = nonceAccount.nonce;        // the durable blockhash (a base58 string)
const authority   = nonceAccount.authorizedPubkey; // who may advance/withdraw/reauthorize
```

`nonceAccount.nonce` is the value you must use as the blockhash. Do NOT call `getLatestBlockhash` for a durable transaction; that defeats the entire purpose and the transaction would expire normally.

**Success criterion:** You have `storedNonce` (the value from the account, not a fresh blockhash) and you have confirmed `authority` matches the key that will sign in Step 4.

### Step 4: Build the durable transaction

A durable transaction has two hard requirements that the runtime checks:

1. **The first instruction MUST be `SystemProgram.nonceAdvance`** with the same `noncePubkey` and `authorizedPubkey` as the account. This instruction is what advances the nonce when the transaction lands, and the runtime only treats a transaction as a durable-nonce transaction when this is instruction index 0. Put your real instructions after it.
2. **`recentBlockhash` MUST be the stored nonce**, not a fresh blockhash:

```ts
const tx = new Transaction();
tx.add(
  SystemProgram.nonceAdvance({
    noncePubkey,
    authorizedPubkey: nonceAuthority.publicKey,
  }),
);
tx.add(/* ...your real instruction(s)... */);

tx.recentBlockhash = storedNonce;          // the value from Step 3, NOT getLatestBlockhash()
tx.feePayer = payer.publicKey;
```

The **nonce authority must be a signer** of this transaction (the advance instruction requires the authority's signature). The fee payer also signs as usual. These can be the same key or different keys.

**Success criterion:** Instruction 0 is `nonceAdvance` with the correct nonce account and authority, `recentBlockhash` equals the stored nonce, and the signer set includes both the nonce authority and the fee payer.

### Step 5: Sign now, submit later

This is the whole point: the signing and the submission can happen far apart in time.

- **Single signer / offline:** serialize the unsigned transaction (`tx.serializeMessage()` or `tx.serialize({ requireAllSignatures: false })`), move it to the signing environment, sign there, move the signed bytes back, submit with `sendRawTransaction`.
- **Multisig over time:** distribute the same serialized message to each party. Each adds its signature with `tx.addSignature(pubkey, signature)` (or signs the identical message bytes). Because every party signs the same fixed message (same stored nonce), the collected signatures all remain valid no matter how long collection takes. Submit once all required signatures are present.

The transaction stays submittable indefinitely. It will be rejected only if the nonce has been advanced in the meantime (see Step 6), which is the expected single-use semantics, not an expiry.

**Success criterion:** The transaction is fully signed over a message whose `recentBlockhash` is the stored nonce, and it can be submitted at any later time without rebuilding.

### Step 6: Understand single-use and advancement

Each successful durable transaction advances the nonce to a new value. Consequences you must design around:

- After submission succeeds, the stored nonce is now different. Any other transaction you built against the old stored value is now invalid and will fail with `BlockhashNotFound` if submitted. This is correct behavior: a nonce is a single-use slot.
- To send a second durable transaction, re-read the account (Step 3) to get the new stored nonce and build against that. Do not reuse the old value.
- Do not pre-sign two transactions against the same stored nonce expecting both to land. Only the first to land succeeds; the second sees an advanced nonce and fails.

**Success criterion:** Your flow re-reads the nonce before each new durable transaction and never reuses a stored nonce value across two transactions.

### Step 7: Manage the account (optional)

Two maintenance operations, both restricted to the nonce authority:

- **Re-authorize** (hand the nonce to a new authority):
  `SystemProgram.nonceAuthorize({ noncePubkey, authorizedPubkey, newAuthorizedPubkey })`. The current authority signs.
- **Withdraw** (reclaim lamports; withdrawing the full balance closes the account):
  `SystemProgram.nonceWithdraw({ noncePubkey, authorizedPubkey, toPubkey, lamports })`. The current authority signs. Leave at least the rent-exemption minimum if you want the account to keep working; withdraw everything only when you are done with it.

**Success criterion:** Authority changes and withdrawals are signed by the current authority, and you keep the account rent-exempt unless you are intentionally closing it.

## Examples

### Example 1: Stand up a reusable nonce account

User input: "Set up a durable nonce account I can sign transactions against later."

The agent runs `examples/create-nonce-account.ts`:

1. Generates (or loads) a nonce-account keypair and a nonce authority.
2. Computes rent via `getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)`.
3. Sends one transaction with `createAccount` + `nonceInitialize`, signed by the fee payer and the nonce-account keypair.
4. Confirms, then reads the account back and prints the initial stored nonce and the authority.

Output the agent reports: the nonce account public key (to save), the nonce authority public key, and the current stored nonce value.

### Example 2: Offline-style sign now, submit later

User input: "Sign a transfer now but I will broadcast it tomorrow. The blockhash keeps expiring."

The agent runs `examples/sign-with-durable-nonce.ts`, which models the offline split with two phases:

1. **Read phase (online):** fetch the nonce account, decode with `NonceAccount.fromAccountData`, take `nonceAccount.nonce` as the durable blockhash.
2. **Sign phase (offline-style):** build a transaction whose instruction 0 is `nonceAdvance` and whose remaining instructions are the real payload (a SOL transfer in the example), set `recentBlockhash` to the stored nonce, set the fee payer, and sign with the nonce authority and fee payer. Serialize the signed bytes.
3. **Submit phase (online, later):** deserialize and `sendRawTransaction`. The example shows it landing even though no fresh blockhash was ever fetched for the payload.

The agent points out that re-running the submit step would fail, because the first submission advanced the nonce; a second send needs a fresh read of the stored value.

### Example 3: Multisig signature collection over time

User input: "Three of us need to sign one transaction but it takes us a day to all get to it."

The agent builds the durable transaction once (instruction 0 `nonceAdvance`, `recentBlockhash` = stored nonce, fee payer set), serializes the message, and distributes it. Each signer signs the identical message bytes and returns their signature; the coordinator attaches each with `tx.addSignature(signerPubkey, signature)`. Because the message is fixed by the stored nonce, partial signatures collected hours apart all remain valid. Once all required signatures are attached, the coordinator submits once. The agent notes the nonce authority must be among the signers for the `nonceAdvance` instruction.

## Guidelines

- **DO** make `SystemProgram.nonceAdvance` the first instruction (index 0) of every durable transaction. The runtime only recognizes a durable-nonce transaction when the advance is instruction 0.
- **DO** set `recentBlockhash` to the value read from the nonce account (`nonceAccount.nonce`), never to `getLatestBlockhash`.
- **DO** include the nonce authority in the signer set; the advance instruction requires its signature.
- **DO** re-read the nonce account before building each new durable transaction, because every successful use advances it.
- **DO** fund the nonce account to rent-exemption (`getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)`) at creation.
- **DON'T** call `getLatestBlockhash` for a durable transaction. A fresh blockhash makes the transaction expire normally and defeats the nonce.
- **DON'T** pre-sign two transactions against the same stored nonce expecting both to land; only the first succeeds and advances the nonce.
- **DON'T** reuse an old stored nonce value after a successful submission; it is now stale.
- **DON'T** let a non-authority key try to advance, withdraw, or re-authorize the nonce; only the recorded authority can.
- **DON'T** withdraw the account below rent-exemption unless you intend to close it.

## Common Errors

| Symptom | Cause | Solution |
|---------|-------|----------|
| `BlockhashNotFound` on a transaction meant to be durable | Used a fresh `getLatestBlockhash` instead of the stored nonce, so it expired normally. | Set `recentBlockhash = nonceAccount.nonce` from a fresh read of the account. |
| `BlockhashNotFound` on a previously valid pre-signed durable tx | The nonce was already advanced by an earlier successful transaction; this one is now stale. | Re-read the nonce account, rebuild and re-sign against the new stored value. |
| Transaction treated as normal (expires) despite a `nonceAdvance` instruction | `nonceAdvance` is not instruction index 0. | Move `nonceAdvance` to be the first instruction; put real instructions after it. |
| Advance/withdraw/reauthorize rejected (missing/invalid signature) | The signing key is not the nonce account's recorded authority, or the authority was not added as a signer. | Sign with the current `authorizedPubkey`; verify it via `NonceAccount.fromAccountData(...).authorizedPubkey`. |
| Creation succeeds but account is unusable / `InsufficientFundsForRent` | Account not funded to rent-exemption, or wrong `space`. | Use `space: NONCE_ACCOUNT_LENGTH` and `lamports = getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)`. |
| Second durable transaction fails after the first lands | Both were built against the same stored nonce; the first advanced it. | Re-read the stored nonce before building the second transaction. |

### Error: durable transaction expires anyway
**Cause:** `recentBlockhash` was set from `getLatestBlockhash` rather than the nonce account's stored value, so the cluster applied the normal expiry window.
**Solution:** Read the account with `NonceAccount.fromAccountData` and set `recentBlockhash` to `nonceAccount.nonce`. Never fetch a fresh blockhash for a durable transaction.

### Error: nonce advanced out from under a pre-signed transaction
**Cause:** Another transaction used the same nonce first (or you reused the stored value), advancing it; the pre-signed transaction now references a stale nonce.
**Solution:** Treat each stored nonce as single-use. Re-read the account to get the current nonce, then rebuild and re-sign.

### Error: only the authority may mutate the nonce
**Cause:** A key other than the recorded `authorizedPubkey` tried to advance, withdraw, or re-authorize.
**Solution:** Use the recorded authority to sign those operations. To move control, the current authority must call `nonceAuthorize` to set a new authority.

## References

- `resources/nonce-mechanics.md` - how the durable nonce replaces the recent blockhash, the on-chain nonce account layout, the advance-first / stored-blockhash / single-use rules, and the full instruction set (`nonceInitialize`, `nonceAdvance`, `nonceWithdraw`, `nonceAuthorize`).
- `examples/create-nonce-account.ts` - create + initialize a rent-exempt nonce account and read back the initial stored nonce. Runnable with `@solana/web3.js`.
- `examples/sign-with-durable-nonce.ts` - offline-style flow: read the stored nonce, build an advance-first transaction, sign now, serialize, submit later. Runnable with `@solana/web3.js`.
- Solana durable nonce guide: https://solana.com/developers/guides/advanced/introduction-to-durable-nonces
- `SystemProgram` nonce instructions (`@solana/web3.js`): https://solana-foundation.github.io/solana-web3.js/classes/SystemProgram.html
- `NonceAccount` reference: https://solana-foundation.github.io/solana-web3.js/classes/NonceAccount.html
- Solana CLI durable nonce docs: https://docs.solanalabs.com/cli/examples/durable-nonce
