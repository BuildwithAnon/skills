# Streamflow: Program IDs, Fees, and Rents

Static reference for the Streamflow streams/vesting protocol on Solana. Do not hardcode the program id in your code: the SDK selects it from the cluster you pass to the client. This file is for verification and reference.

## Program IDs

| Cluster | Streamflow program id |
|---------|------------------------|
| Mainnet-beta | `strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m` |
| Devnet | `HqDGZjaVRXJ9MGRQEw7qDc2rAr6iH1n1kAQdCZaCMfMZ` |

- The `SolanaStreamClient` picks the program id from the `ICluster` you pass to its constructor (`new SolanaStreamClient(clusterUrl, ICluster.Devnet)`), defaulting to `Mainnet`. Pass both the matching RPC URL and the `ICluster` so reads and writes hit the same network; the URL alone does not select the program id.
- These program ids are the streams/vesting program. Streamflow's airdrop/distributor and other products use different program ids and a different SDK package, which this skill does not cover.

## RPC URLs

| Cluster | Example RPC URL |
|---------|-----------------|
| Mainnet-beta | `https://api.mainnet-beta.solana.com` |
| Devnet | `https://api.devnet.solana.com` |

Use a dedicated RPC provider for production; the public endpoints are rate limited.

## Fees

| Fee | Amount | Who pays | When |
|-----|--------|----------|------|
| Protocol fee | 0.25% of the total streamed amount | sender | deducted at `create` |
| Automatic-withdrawal fee | ~0.19 SOL upfront | sender | at `create`, only when `automaticWithdrawal: true` |

- The 0.25% protocol fee is taken from the total at creation, so the recipient receives at most ~99.75% of `amount`. If a recipient must receive an exact net, gross up `amount` to compensate.
- The ~0.19 SOL automatic-withdrawal fee is charged only when you enable `automaticWithdrawal`. Leave it off and let the recipient call `withdraw` to avoid it.
- Confirm the exact current fee values against the live protocol/docs before relying on them for accounting; fees are protocol parameters and can change.

## Rents (paid by the sender at creation)

The sender pays SOL rent-exemption for the accounts the stream creates:

- The **metadata account** (this account's pubkey is the stream `id` returned in `metadata`).
- The **escrow token account** that holds the locked tokens.
- The **recipient's associated token account (ATA)**, if it does not already exist for the mint.

Fund the sender wallet with enough SOL to cover all three rents plus the protocol fee (and the ~0.19 SOL fee if auto-withdraw is enabled) before sending `create`.

## SOL streaming

To stream native SOL rather than an SPL token, pass `isNative: true` in the second argument of `create`. The SDK wraps SOL to wSOL into the escrow and unwraps on withdraw. For any SPL token leave `isNative: false`.

## Token-2022

`ICreateStreamData` exposes an optional `tokenProgramId` field. To stream a Token-2022 mint, set `tokenProgramId` to the Token-2022 program id (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`); it defaults to the classic SPL Token program. The mint must use the streamed token program consistently across the escrow and recipient accounts.
