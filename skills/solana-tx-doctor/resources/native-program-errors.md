# Native Program Error Tables

When `{ Custom: N }` with `N < 6000` comes from a built-in (native) program, the number is that program's own error code, not an Anchor code. Resolve it against the program that actually reverted (from the CPI stack), using the table for that program below. Codes are shown as decimal (the `meta.err` form); the hex log form is `0x` + the same value in base 16 (for example decimal 1 is `0x1`, decimal 16 is `0x10`).

First identify the program by its id, then read its table.

| Program | Program id |
|---------|------------|
| System | `11111111111111111111111111111111` |
| SPL Token (classic) | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Token-2022 | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| Associated Token Account | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL` |
| Compute Budget | `ComputeBudget111111111111111111111111111111` |
| Address Lookup Table | `AddressLookupTab1e1111111111111111111111111` |
| Stake | `Stake11111111111111111111111111111111111111` |
| Vote | `Vote111111111111111111111111111111111111111` |

SPL Token (classic) `TokenError` is the most common native source and is already covered in `decode-reference.md` Path 5. The rest follow.

## System Program (`SystemError` / SystemInstruction error)

The System program reports most failures as `TransactionError` variants rather than `Custom` codes (for example `InsufficientFundsForRent`, or an `InstructionError` string variant). Its own enumerated `Custom` codes:

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 0 | AccountAlreadyInUse | Tried to create an account at an address that already exists. | Use a different address, or skip creation if it already exists. |
| 1 | ResultWithNegativeLamports | A transfer would drive lamports negative. | Reduce the amount or fund the source. |
| 2 | InvalidProgramId | Assigned owner is not a valid program. | Assign a real program id. |
| 3 | InvalidAccountDataLength | `space` requested does not match. | Pass the correct `space` for the account. |
| 4 | MaxSeedLengthExceeded | A seed exceeded 32 bytes. | Shorten the seed. |
| 5 | AddressWithSeedMismatch | `createWithSeed` address did not match base+seed+owner. | Recompute the derived address with the exact base, seed, and owner. |
| 6 | NonceNoRecentBlockhashes | Durable nonce: no recent blockhashes available. | Retry; ensure the nonce account is initialized. |
| 7 | NonceBlockhashNotExpired | Advanced a nonce that has not yet been used. | Use the current nonce value, or advance after use. |
| 8 | NonceUnexpectedBlockhashValue | The stored nonce did not match the transaction's blockhash. | Refetch the nonce account and rebuild with its current value. |

Common shape: creating an account that already exists shows up as `AccountAlreadyInUse` (0) or, at the transaction level, as `AlreadyProcessed` if it is a duplicate send. Account-creation underfunding usually surfaces as `InsufficientFundsForRent` (a `TransactionError`, see error-classes.md), not a System `Custom` code.

## Associated Token Account program (`AssociatedTokenAccountError`)

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 0 | InvalidOwner | The ATA's derived owner did not match. | Recreate the ATA with the correct wallet and mint; use `getAssociatedTokenAddressSync(mint, owner, allowOwnerOffCurve, tokenProgramId)`. |

The far more common ATA failures are not `Custom` codes at all:
- Creating an ATA that already exists reverts; use `createAssociatedTokenAccountIdempotentInstruction` so a pre-existing ATA is a no-op instead of a revert.
- Deriving the ATA under the wrong token program (classic vs Token-2022) yields a mismatch (`IncorrectProgramId` / Anchor `3007 AccountOwnedByWrongProgram`). Pass the mint's actual owner program as the `tokenProgramId` argument when deriving and when building the create instruction.

## Token-2022 program (`TokenError` + extension errors)

Token-2022 shares the classic `TokenError` codes 0 to 18 (so `1 = InsufficientFunds`, `3 = MintMismatch`, `4 = OwnerMismatch` behave the same), then adds extension-specific codes above them. The high-value extension errors:

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 12 | NonNativeNotSupported | Operation requires a native (wrapped SOL) account. | Use a native account, or the correct instruction for the mint type. |
| 16 | AccountFrozen | The token account is frozen by the freeze authority. | Thaw it (freeze authority required) before transferring. |
| 19 | ExtensionTypeMismatch | Wrong extension for this account/mint. | Initialize the account with the extensions the mint requires. |
| 23 | MintHasSupply | Cannot perform the op while supply is nonzero. | Burn/close holders first. |
| 27 | NoMemoOnTransfer (MemoTransfer) | The recipient requires a memo and none was attached. | Prepend a Memo-program instruction in the same transaction. |
| 30 | NonTransferable | The mint is non-transferable (soulbound). | The token cannot be transferred by design. |
| 31 | TransferFeeExceedsMaximum | Transfer-fee config conflict. | Use the mint's actual fee config when building the transfer. |
| 35 | MintRequiredForTransfer | `transferChecked` is required (mint must be passed). | Use `transferChecked` / `transfer_checked`, which passes the mint and decimals. |
| 36 | AccountDecryptionFailed (confidential) | Confidential-transfer ciphertext failed to decrypt. | Re-derive the ElGamal keys / proofs. |

The single most important Token-2022 failure for CPI debugging is a **transfer hook**. A mint with the TransferHook extension routes every transfer through a separate hook program. If that hook program reverts, the failure appears two levels deep in the CPI stack (Token-2022 invoked the hook, the hook reverted), and the top-level `InstructionError[0]` still points at your transfer instruction. The fix is to include the hook program and its extra account metas (resolved via the hook's `ExtraAccountMetaList` PDA) in the transfer; the spl helpers add these automatically when you build the transfer with the on-chain extra-account resolution. See the golden CPI example for the full trace.

Decisive rule: read the mint account's `owner`. If it is `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`, you must use the Token-2022 program id (and `transferChecked` plus any hook accounts) everywhere, not classic SPL Token.

## Compute Budget program

The Compute Budget program itself rarely returns a `Custom` code; misuse surfaces as a `TransactionError` or an `InstructionError` string variant:

| Symptom | Meaning | Remediation |
|---------|---------|-------------|
| `{ InstructionError: [i, "ComputeBudgetExceeded"] }` | An instruction used more CU than the (default or set) limit. | Prepend `ComputeBudgetProgram.setComputeUnitLimit(simulatedUnits * 1.15)`. |
| Duplicate `setComputeUnitLimit` / `setComputeUnitPrice` | More than one of the same compute-budget instruction. | Include each compute-budget instruction at most once. |
| `DuplicateInstruction(index)` | Two compute-budget directives of the same kind. | Remove the duplicate. |

Default budget is 200,000 CU per instruction (up to a 1.4M CU transaction cap), so any heavy program or multi-CPI swap needs an explicit, simulation-sized limit.

## Address Lookup Table program

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 0 | LookupTableNotFound (built-in path) | The referenced ALT account does not exist. | Use a real, current ALT address; fetch it before building. |
| 1 | (extend) | Cannot extend a deactivated/closed table. | Use an active table; create a new one if needed. |

At the transaction level, ALT problems usually appear as `AddressLookupTableNotFound`, `InvalidAddressLookupTableOwner`, `InvalidAddressLookupTableData`, or `InvalidAddressLookupTableIndex` (see error-classes.md). The classic cause is a v0 transaction whose lookup index points past the table's current length (the table changed after the message was built), or a freshly extended table that is not yet warmed up for the current slot. Refetch the lookup table accounts with `connection.getAddressLookupTable(...)`, rebuild the v0 message, and resend.

## Stake program (`StakeError`)

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 0 | NoCreditsToRedeem | No rewards to redeem yet. | Wait for an epoch boundary. |
| 1 | LockupInForce | The stake account is still locked. | Wait for the lockup to expire, or use the lockup custodian. |
| 2 | AlreadyDeactivated | Tried to deactivate an already-deactivating stake. | Skip; it is already deactivating. |
| 3 | TooSoonToRedelegate | Re-delegated within the same epoch. | Wait until the next epoch. |
| 4 | InsufficientStake | Split/withdraw amount exceeds available stake above rent. | Reduce the amount; leave rent-exemption in the source. |
| 6 | MergeMismatch | Two stake accounts are not mergeable (state/authority/voter differ). | Only merge compatible accounts. |

Withdrawing or splitting below rent-exemption surfaces as `InsufficientStake` (4) or, at the transaction level, as an `InsufficientFundsForRent`. Always leave the rent-exempt minimum in the source account.

## Vote program (`VoteError`)

| Code | Name | Meaning | Remediation |
|------|------|---------|-------------|
| 0 | VoteTooOld | Vote slot is older than the last voted slot. | Vote on a newer slot. |
| 3 | TooSoonToReauthorize | Re-authorized the vote account too soon. | Wait the required interval. |
| 6 | SlotsMismatch / lockout | Vote violates lockout/slot ordering. | Submit a consistent vote tower. |

Vote errors are mostly validator-operator territory; an application agent rarely produces them. If one appears, the transaction is targeting a vote account it should not be touching.

## How to use these tables

1. Convert any hex code from the logs to decimal.
2. Identify the program that actually reverted from the CPI stack (decode-reference.md Path 7), not the top-level program.
3. If that program is one of the above, read its row. Confirm against the program's own source/IDL when the meaning drives a destructive action.
4. If the program is third-party (a DEX or custom protocol), use `resources/dex-error-codes.md` and the IDL `errors`-array lookup instead.

## References

- SPL Token / Token-2022 errors: https://github.com/solana-program/token and https://github.com/solana-program/token-2022
- Associated Token Account: https://github.com/solana-program/associated-token-account
- System program: https://github.com/anza-xyz/agave (programs/system)
- Address Lookup Table program: https://github.com/anza-xyz/agave (programs/address-lookup-table)
- Stake program (`StakeError`): https://github.com/anza-xyz/agave (programs/stake)
- Vote program (`VoteError`): https://github.com/anza-xyz/agave (programs/vote)
- Compute Budget: https://github.com/anza-xyz/agave (sdk/compute-budget)
