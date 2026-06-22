# Durable Nonce Mechanics

The reference for how a durable nonce replaces the expiring recent blockhash, the on-chain account that stores it, the rules the runtime enforces, and the full instruction set. Use this when you need to understand or debug a durable-nonce flow beyond the step-by-step in SKILL.md.

## Why a normal blockhash expires

Every Solana transaction includes a `recentBlockhash`. The cluster keeps a sliding window of recent blockhashes (roughly the last 150 slots, about 60 to 90 seconds of wall time). A transaction is only accepted while its blockhash is still inside that window; once the window passes the blockhash, the transaction is rejected with `BlockhashNotFound`. This is a deliberate replay-protection and liveness mechanism: it bounds how long a transaction can sit waiting to be included, and it stops an old signed transaction from being replayed forever.

That same mechanism is the problem for any flow where signing and submission are separated by more than the window: offline / air-gapped signing, hardware-wallet confirmation, multisig signature collection over hours or days, and scheduled or queued transactions. The signed bytes are valid, but the blockhash inside them has expired by the time they reach the network.

## What a durable nonce changes

A durable nonce swaps the expiring recent blockhash for a value that does not expire on a timer. Instead of `recentBlockhash` being a fresh cluster blockhash, it is a **stored value held in an on-chain nonce account**. The cluster accepts a transaction whose `recentBlockhash` equals the current stored value of a referenced nonce account, regardless of how much time has passed, as long as that stored value has not changed.

The stored value changes only when a transaction successfully uses the nonce: each such transaction includes an "advance nonce" instruction that rotates the stored value to a new one. So the lifetime model flips from "valid for ~90 seconds" to "valid until used exactly once." That single-use rotation preserves replay protection (you cannot replay the transaction, because the nonce it referenced is now different) while removing the timer.

## The nonce account

A nonce account is a regular account owned by the System Program, of fixed size `NONCE_ACCOUNT_LENGTH` (80 bytes). It must be rent-exempt. Its data holds:

- A **version / state** marker (uninitialized vs initialized).
- The **authority** (`authorizedPubkey`): the only key allowed to advance, withdraw from, or re-authorize the nonce.
- The **stored durable nonce** (a blockhash-shaped 32-byte value), which is what a durable transaction uses as its `recentBlockhash`.
- A **fee calculator** snapshot recorded with the nonce.

In `@solana/web3.js` you read it by fetching the account and decoding:

```ts
const info = await connection.getAccountInfo(noncePubkey);
const nonceAccount = NonceAccount.fromAccountData(info.data);
nonceAccount.nonce;            // the stored durable blockhash (base58 string) -> use as recentBlockhash
nonceAccount.authorizedPubkey; // the authority
```

The field exposed as `nonceAccount.nonce` is the durable blockhash. `nonceAccount.authorizedPubkey` is the authority. (Field names follow `@solana/web3.js`; verify against the version you are on if a property is missing.)

## The four rules the runtime enforces

A durable-nonce transaction only works if all four hold. Three of the four common failure modes are violations of these.

1. **Advance must be the first instruction.** The transaction's instruction at index 0 must be `SystemProgram.nonceAdvance` referencing the nonce account and its authority. The runtime only classifies a transaction as a durable-nonce transaction when the advance is instruction 0; otherwise it is treated as an ordinary transaction and the (stale) blockhash is subjected to the normal expiry window.

2. **`recentBlockhash` must equal the stored nonce.** Set `tx.recentBlockhash = nonceAccount.nonce`. Using a fresh `getLatestBlockhash` value makes the transaction expire normally and defeats the nonce.

3. **The authority must sign.** The `nonceAdvance` (and `nonceWithdraw`, `nonceAuthorize`) instructions require the nonce authority's signature. The fee payer signs as usual; the authority and fee payer may be the same key or different keys.

4. **Single use per advance.** A nonce is valid for exactly one successful transaction. That transaction advances the stored value, which invalidates any other transaction built against the previous value. To send another durable transaction, re-read the account to get the new stored value and build against it.

## The instruction set

All four come from `SystemProgram` in `@solana/web3.js`.

| Instruction | Purpose | Who signs |
|-------------|---------|-----------|
| `SystemProgram.nonceInitialize({ noncePubkey, authorizedPubkey })` | Write the first durable nonce into a freshly created account and record the authority. Paired with `createAccount` in the same transaction. | Fee payer + the new nonce-account keypair (account creation). |
| `SystemProgram.nonceAdvance({ noncePubkey, authorizedPubkey })` | Rotate the stored nonce to a new value. Must be instruction 0 of any durable transaction. | Nonce authority. |
| `SystemProgram.nonceWithdraw({ noncePubkey, authorizedPubkey, toPubkey, lamports })` | Move lamports out of the nonce account. Withdrawing the full balance closes it; leave the rent-exemption minimum to keep it working. | Nonce authority. |
| `SystemProgram.nonceAuthorize({ noncePubkey, authorizedPubkey, newAuthorizedPubkey })` | Transfer control of the nonce to a new authority. | Current nonce authority. |

### Creation pairing

`nonceInitialize` does not create the account; it initializes one that already exists. So creation is always two instructions in a single transaction:

```ts
SystemProgram.createAccount({
  fromPubkey: payer.publicKey,
  newAccountPubkey: nonceAccount.publicKey,
  lamports: rentExemptMinimum,         // getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)
  space: NONCE_ACCOUNT_LENGTH,
  programId: SystemProgram.programId,   // nonce accounts are System-owned
}),
SystemProgram.nonceInitialize({
  noncePubkey: nonceAccount.publicKey,
  authorizedPubkey: nonceAuthority.publicKey,
}),
```

## Lifetime and replay safety

A durable-nonce transaction is not "valid forever" in a way that breaks replay protection. It is valid until used once. The advance rotates the stored nonce, so the exact signed bytes cannot be replayed: a replay would reference a nonce value that no longer matches the account. This is why two transactions cannot both spend the same stored nonce. The first to land succeeds and advances; the second references a stale value and fails with `BlockhashNotFound`. Design any multi-transaction flow to re-read the stored nonce between transactions.

## Rent

The nonce account must stay rent-exempt to persist. Fund it at creation with `getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH)`. Withdrawing below that minimum risks the account being purged; withdraw the full balance only when you intend to close the account and are done with the nonce.

## When NOT to use a durable nonce

If signing and submission happen in the same short-lived process and a normal `getLatestBlockhash` is good enough, do not add a nonce account. It costs rent, an extra account to manage, and an extra instruction on every transaction. Reach for it only when time genuinely separates the signer from the sender, or when multiple parties must sign one fixed message over a long period.
