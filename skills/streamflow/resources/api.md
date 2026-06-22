# Streamflow SDK: Methods, Parameters, and Enums

Reference for `@streamflow/stream@12.4.0` (the current published version, confirmed on npm). The package ships its own types. All amounts are `BN` in the token's smallest units; all timestamps are UNIX seconds.

## Imports

In v12 the client, enums, helpers, and types are all top-level named exports (the older `StreamflowSolana`/`GenericStreamClient`/`Types` namespaces no longer exist):

```ts
import {
  SolanaStreamClient,  // the Solana stream client
  ICluster,            // Mainnet | Devnet | Testnet | Local
  StreamType,          // All | Vesting | Lock
  StreamDirection,     // Outgoing | Incoming | All
  ContractError,       // protocol error carrying contractErrorCode
  getBN,               // number/string -> BN in smallest units
  getNumberFromBN,     // BN -> number in human units
  type ICreateStreamData,
} from "@streamflow/stream";
```

## Client construction

```ts
const client = new SolanaStreamClient(
  clusterUrl: string,         // e.g. "https://api.mainnet-beta.solana.com"
  cluster?: ICluster,         // selects the program id; defaults to ICluster.Mainnet
  commitment?,                // Commitment | ConnectionConfig
  programId?: string          // override (rarely needed)
);
```

Pass `cluster` explicitly (e.g. `ICluster.Devnet`) when not on mainnet, so the client targets the right program id. On protocol failures the client throws a `ContractError` carrying a `contractErrorCode`. Catch it to surface structured error codes.

## Methods

All write methods take the action data as the first argument and a signer/options object as the second. The stream `id` is the metadata account pubkey returned by `create`.

### create

```ts
const { ixs, txId, metadataId } = await client.create(
  data: ICreateStreamData,
  { sender, isNative }: { sender: Keypair | SignerWalletAdapter; isNative?: boolean }
);
```

- Returns `{ ixs, txId, metadataId }`. `metadataId` is the new stream's id (the metadata account pubkey). Persist it. `txId` is the confirmed transaction signature.
- `sender` is the signer (a `Keypair` or wallet adapter).
- `isNative: true` wraps/unwraps native SOL; default `false` for SPL tokens.

### createMultiple

```ts
await client.createMultiple(
  { recipients: IRecipient[], ...sharedStreamData },
  { sender, isNative }
);
```

Create several streams in one flow (one recipient per entry, shared schedule fields). Check the installed types for the exact shape; use it for batch vesting (e.g. many investors on identical terms).

### withdraw

```ts
await client.withdraw(
  { id: string, amount?: BN },       // amount optional; omit it to drain all available
  { invoker: Keypair | SignerWalletAdapter }  // usually the recipient
);
```

Withdraws at most the currently-unlocked balance. `amount` is optional: omit it to withdraw everything available. Requesting more than unlocked reverts.

### cancel

```ts
await client.cancel(
  { id: string },
  { invoker: Keypair | SignerWalletAdapter }  // a party the stream marked cancelable
);
```

Returns the still-locked remainder to the sender; already-unlocked funds stay with the recipient. Only valid for an invoker permitted by `cancelableBySender` / `cancelableByRecipient`.

### transfer

```ts
await client.transfer(
  { id: string, newRecipient: string },
  { invoker: Keypair | SignerWalletAdapter }  // permitted by transferableBySender / transferableByRecipient
);
```

Hands the recipient role to `newRecipient`.

### topup

```ts
await client.topup(
  { id: string, amount: BN },
  { invoker: Keypair | SignerWalletAdapter }  // usually the sender
);
```

Adds funds to a stream. Only works if the stream was created with `canTopup: true`. Reverts on a fixed vesting stream (`canTopup: false`).

### update

```ts
await client.update(
  { id: string, /* fields such as amountPerPeriod, automaticWithdrawal, withdrawalFrequency */ },
  { invoker: Keypair | SignerWalletAdapter }
);
```

Changes mutable stream parameters (e.g. the rate) when allowed, typically requiring `canUpdateRate: true` at creation. Check the installed types for the exact updatable field set.

### getOne

```ts
const stream = await client.getOne({ id: string });
```

Returns a single stream's on-chain data by id. Convert amount fields with `getNumberFromBN`.

### get

```ts
const streams = await client.get({
  address: string,                  // wallet to filter by
  type: StreamType.All,             // All | Vesting | Lock
  direction: StreamDirection.All,   // Outgoing | Incoming | All
});
```

Returns `[id, Stream][]` tuples for the wallet, filtered by type and direction.

## ICreateStreamData fields

| Field | Type | Notes |
|-------|------|-------|
| `recipient` | string (pubkey) | recipient wallet |
| `tokenId` | string (pubkey) | SPL mint to stream |
| `start` | number | UNIX seconds, unlock begins |
| `amount` | BN | total locked, `getBN(total, decimals)` |
| `period` | number | seconds between unlock steps |
| `cliff` | number | UNIX seconds the cliff unlocks |
| `cliffAmount` | BN | released at the cliff (`getBN(0, decimals)` for none) |
| `amountPerPeriod` | BN | released each `period` |
| `name` | string | on-chain label |
| `canTopup` | boolean | `false` = vesting, `true` = streaming payment |
| `canUpdateRate` | boolean | allow `update` to change the rate |
| `cancelableBySender` | boolean | sender may cancel |
| `cancelableByRecipient` | boolean | recipient may cancel |
| `transferableBySender` | boolean | sender may transfer recipient role |
| `transferableByRecipient` | boolean | recipient may transfer recipient role |
| `automaticWithdrawal` | boolean | protocol auto-pushes unlocked funds |
| `withdrawalFrequency` | number | seconds; REQUIRED when `automaticWithdrawal: true` |
| `canPause` | boolean | optional, allow pausing the stream |
| `partner` | string (pubkey) | optional, fee-sharing partner |
| `tokenProgramId` | string \| PublicKey | optional; set to the Token-2022 program id for a Token-2022 mint, else defaults to classic SPL Token |

Consistency rule: `cliffAmount + (periods * amountPerPeriod)` should equal `amount` over the span from `cliff` to the end; account for rounding.

## Helpers

```ts
getBN(value: number | string, decimals: number): BN   // human -> smallest units
getNumberFromBN(bn: BN, decimals: number): number      // smallest units -> human
```

Always convert into `BN` before passing amounts, and out of `BN` before displaying them.

## Enums

```ts
StreamType       // All | Vesting | Lock   (no Payment member; payment vs vesting is the canTopup flag)
StreamDirection  // Outgoing | Incoming | All
ICluster         // Mainnet | Devnet | Testnet | Local
```

## Error handling

- `SolanaStreamClient` throws `ContractError` with a `contractErrorCode` field on protocol failures. Catch and inspect it for structured handling.
- For raw Solana transaction failures (blockhash expiry, compute budget, custom program errors), diagnose with the standard transaction tooling.
