/**
 * diagnose-signature.ts
 *
 * Diagnose a failed Solana transaction from its signature.
 *
 * Procedure: fetch -> classify -> decode (logs first, IDL fallback)
 *            -> locate (CPI-stack log parsing) -> remediate.
 *
 * Run:
 *   npm i @solana/web3.js
 *   RPC_URL=https://api.mainnet-beta.solana.com \
 *     npx tsx diagnose-signature.ts <SIGNATURE>
 *
 * Optional: pass an IDL JSON path to enable code>=6000 fallback decode
 * when the logs do not already contain an Anchor decoded line:
 *   IDL_PATH=./my_program.json npx tsx diagnose-signature.ts <SIGNATURE>
 */

import { Connection } from "@solana/web3.js";
import { readFileSync } from "node:fs";

type ErrClass =
  | "dropped"
  | "anchor-custom-error"
  | "native-program-error"
  | "compute-budget-exceeded"
  | "rent"
  | "raw-instruction-variant"
  | "transaction-level";

interface Diagnosis {
  class: ErrClass;
  errorName: string;
  message: string;
  failingInstructionIndex: number | null;
  revertedProgram: string | null;
  accountIndex: number | null;
  retrySafe: boolean;
  fix: string;
}

// Minimal Anchor IDL error shape.
interface IdlError {
  code: number;
  name: string;
  msg?: string;
}

// ---------------------------------------------------------------------------
// Step 3 helpers: decode
// ---------------------------------------------------------------------------

/** Parse the Anchor decoded line from logs, if present. */
function parseAnchorLogError(
  logs: string[]
): { name: string; number: number; msg: string } | null {
  for (const line of logs) {
    const m = line.match(
      /Error Code: (\w+)\. Error Number: (\d+)\. Error Message: (.+?)\.?$/
    );
    if (m) return { name: m[1], number: Number(m[2]), msg: m[3] };
  }
  return null;
}

/** Pull a hex custom-program-error code from logs and convert to decimal. */
function parseHexCodeFromLogs(logs: string[]): number | null {
  for (const line of logs) {
    const m = line.match(/custom program error: (0x[0-9a-fA-F]+)/);
    if (m) return parseInt(m[1], 16);
  }
  return null;
}

/** SPL Token built-in error names (code < 100), in on-chain TokenError order. */
const TOKEN_ERRORS: Record<number, string> = {
  0: "NotRentExempt",
  1: "InsufficientFunds",
  2: "InvalidMint",
  3: "MintMismatch",
  4: "OwnerMismatch",
  5: "FixedSupply",
  6: "AlreadyInUse",
};

/** Anchor framework range -> human meaning (code 100..5999). */
function anchorFrameworkMeaning(code: number): string | null {
  if (code >= 2500 && code <= 2599) return `Require violated (${code})`;
  if (code >= 2000 && code <= 2999) return `Constraint error (${code})`;
  if (code >= 3000 && code <= 3999) return `Account error (${code})`;
  if (code >= 1000 && code <= 1999) return `IDL instruction error (${code})`;
  if (code >= 100 && code < 1000) return `Instruction error (${code})`;
  if (code === 4100) return `DeclaredProgramIdMismatch (${code})`;
  if (code >= 5000 && code < 6000) return `Misc framework error (${code})`;
  return null;
}

/** IDL errors-array lookup for a program custom error (code >= 6000). */
function lookupIdlError(idl: { errors?: IdlError[] }, code: number): IdlError | null {
  return idl.errors?.find((e) => e.code === code) ?? null;
}

// ---------------------------------------------------------------------------
// Step 4 helper: locate the program that actually reverted via the CPI stack
// ---------------------------------------------------------------------------

/**
 * Reconstruct the invoke/success/failed stack and return the program id of the
 * deepest frame that was still open at the failure line. That is the program
 * that actually reverted, even when InstructionError[0] points at a top-level
 * instruction whose CPI failed.
 */
function locateRevertedProgram(logs: string[]): string | null {
  const stack: string[] = [];
  let reverted: string | null = null;
  for (const line of logs) {
    const invoke = line.match(/Program (\S+) invoke \[(\d+)\]/);
    if (invoke) {
      stack.push(invoke[1]);
      continue;
    }
    if (/Program \S+ success/.test(line)) {
      stack.pop();
      continue;
    }
    const failed = line.match(/Program (\S+) failed:/);
    if (failed) {
      // The first 'failed' line is the innermost program that reverted.
      reverted = reverted ?? failed[1];
    }
  }
  return reverted ?? (stack.length ? stack[stack.length - 1] : null);
}

// ---------------------------------------------------------------------------
// Step 2 + 3 + 5: classify, decode, remediate
// ---------------------------------------------------------------------------

function diagnose(
  err: unknown,
  logs: string[],
  idl: { errors?: IdlError[] } | null
): Diagnosis {
  const e = err as any;

  // --- transaction-level / dropped strings ---
  if (typeof e === "string") {
    if (e === "BlockhashNotFound" || e === "AlreadyProcessed") {
      return {
        class: "dropped",
        errorName: e,
        message: "Transaction never executed (expired/duplicate blockhash).",
        failingInstructionIndex: null,
        revertedProgram: null,
        accountIndex: null,
        retrySafe: true,
        fix: "Fetch a fresh blockhash, re-sign, resend, confirm against the new lastValidBlockHeight.",
      };
    }
    return {
      class: "transaction-level",
      errorName: e,
      message: `Transaction-level rejection: ${e}.`,
      failingInstructionIndex: null,
      revertedProgram: null,
      accountIndex: null,
      retrySafe: false,
      fix: txLevelFix(e),
    };
  }

  // --- rent ---
  if (e && typeof e === "object" && "InsufficientFundsForRent" in e) {
    const accountIndex = e.InsufficientFundsForRent.account_index ?? null;
    return {
      class: "rent",
      errorName: "InsufficientFundsForRent",
      message: `Account index ${accountIndex} ended below rent-exemption.`,
      failingInstructionIndex: null,
      revertedProgram: locateRevertedProgram(logs),
      accountIndex,
      retrySafe: false,
      fix: "Fund the account to rent-exemption (a token account needs ~0.00204 SOL), then rebuild.",
    };
  }

  // --- per-instruction errors ---
  if (e && typeof e === "object" && Array.isArray(e.InstructionError)) {
    const [ix, detail] = e.InstructionError as [number, any];
    const reverted = locateRevertedProgram(logs);

    // String instruction variants
    if (typeof detail === "string") {
      if (detail === "ComputeBudgetExceeded") {
        return {
          class: "compute-budget-exceeded",
          errorName: detail,
          message: `Instruction #${ix} exceeded its compute-unit limit.`,
          failingInstructionIndex: ix,
          revertedProgram: reverted,
          accountIndex: null,
          retrySafe: false,
          fix: "Add ComputeBudgetProgram.setComputeUnitLimit sized from simulated unitsConsumed + ~15% margin, then rebuild.",
        };
      }
      return {
        class: "raw-instruction-variant",
        errorName: detail,
        message: `Instruction #${ix} failed with variant ${detail}.`,
        failingInstructionIndex: ix,
        revertedProgram: reverted,
        accountIndex: null,
        retrySafe: false,
        fix: rawVariantFix(detail),
      };
    }

    // Custom { Custom: N }
    if (detail && typeof detail === "object" && "Custom" in detail) {
      const code: number = detail.Custom;

      // Decode: logs first.
      const logErr = parseAnchorLogError(logs);
      if (logErr && logErr.number === code) {
        return {
          class: code >= 6000 ? "anchor-custom-error" : "native-program-error",
          errorName: logErr.name,
          message: logErr.msg,
          failingInstructionIndex: ix,
          revertedProgram: reverted,
          accountIndex: null,
          retrySafe: false,
          fix: code >= 6000
            ? "Program assertion failed (e.g. slippage/deadline/auth). Fix the input, do not blind-retry."
            : "Built-in program check failed. Correct the instruction, do not blind-retry.",
        };
      }

      // Anchor custom (>= 6000): IDL fallback, with the slippage default hypothesis.
      if (code >= 6000) {
        const fromIdl = idl ? lookupIdlError(idl, code) : null;
        // 0x1771 (6001) on a DEX is the >80% case: exceeded desired slippage.
        const slippageHint =
          code === 6001
            ? " Note: 0x1771 (6001) on a swap is almost always exceeded slippage; see resources/dex-error-codes.md."
            : "";
        return {
          class: "anchor-custom-error",
          errorName: fromIdl?.name ?? `Custom(${code})`,
          message:
            (fromIdl?.msg ??
              `Program custom error ${code} (0x${code.toString(16)}). No decoded log line and no IDL match; fetch the program IDL to resolve.`) +
            slippageHint,
          failingInstructionIndex: ix,
          revertedProgram: reverted,
          accountIndex: null,
          retrySafe: false,
          fix:
            code === 6001
              ? "Likely slippage: refresh the quote, raise slippageBps, rebuild on a fresh blockhash. No blind-retry."
              : "Program assertion failed. Fix the input (re-quote, raise slippage, correct amount/auth), rebuild. No blind-retry.",
        };
      }

      // Native (< 100): token error names, else framework range.
      const token = TOKEN_ERRORS[code];
      const framework = anchorFrameworkMeaning(code);
      return {
        class: "native-program-error",
        errorName: token ?? framework ?? `Custom(${code})`,
        message:
          token != null
            ? `SPL Token error ${code}: ${token}.`
            : framework ?? `Built-in program error ${code} from ${reverted ?? "unknown program"}.`,
        failingInstructionIndex: ix,
        revertedProgram: reverted,
        accountIndex: null,
        retrySafe: false,
        fix: "Correct the instruction (balance, owner, mint, or token program id), rebuild. No blind-retry.",
      };
    }
  }

  // --- unknown object ---
  const hex = parseHexCodeFromLogs(logs);
  return {
    class: "transaction-level",
    errorName: hex != null ? `Custom(${hex})` : "Unknown",
    message:
      hex != null
        ? `Unresolved program error ${hex} (from log hex). Resolve via IDL or registry.`
        : `Unrecognized error shape: ${JSON.stringify(e)}.`,
    failingInstructionIndex: null,
    revertedProgram: locateRevertedProgram(logs),
    accountIndex: null,
    retrySafe: false,
    fix: "Inspect logs and resolve the code via the decode reference before acting.",
  };
}

function txLevelFix(name: string): string {
  switch (name) {
    case "AccountNotFound":
      return "Create/fund the referenced account or fix the address.";
    case "AccountInUse":
    case "AccountLoadedTwice":
      return "Deduplicate writable accounts; retry only if it was a transient lock.";
    case "SignatureFailure":
    case "MissingSignature":
      return "Add the missing signer and re-sign over the final message.";
    case "InsufficientFundsForFee":
    case "InvalidAccountForFee":
      return "Fund the fee payer with SOL.";
    default:
      return "Resolve per the TransactionError variant table in resources/error-classes.md.";
  }
}

function rawVariantFix(name: string): string {
  switch (name) {
    case "PrivilegeEscalation":
      return "An inner instruction needed a privilege not granted. Mark the account signer/writable on the outer instruction.";
    case "MissingRequiredSignature":
      return "Add the required signer and re-sign.";
    case "ProgramFailedToComplete":
      return "Program panicked or hit a limit. Simulate to read the panic log; raise CU or fix inputs.";
    case "IncorrectProgramId":
      return "Use the correct program id (e.g. the mint's actual owner: classic SPL vs Token-2022).";
    default:
      return "Resolve per the TransactionError variant table in resources/error-classes.md.";
  }
}

// ---------------------------------------------------------------------------
// Main: Step 0 + Step 1 (fetch), then print structured diagnosis
// ---------------------------------------------------------------------------

async function main() {
  const signature = process.argv[2];
  if (!signature) {
    console.error("Usage: npx tsx diagnose-signature.ts <SIGNATURE>");
    process.exit(1);
  }
  const rpc = process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpc, "confirmed");

  let idl: { errors?: IdlError[] } | null = null;
  if (process.env.IDL_PATH) {
    idl = JSON.parse(readFileSync(process.env.IDL_PATH, "utf8"));
  }

  // Step 1: fetch (maxSupportedTransactionVersion is required for v0 txs).
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });

  if (tx === null) {
    // Not on chain: confirm dropped vs too-early.
    const status = await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const value = status.value[0];
    if (value === null) {
      const d: Diagnosis = {
        class: "dropped",
        errorName: "NotFound / Dropped",
        message:
          "Transaction is not on chain. If lastValidBlockHeight has passed, it was dropped and never executed.",
        failingInstructionIndex: null,
        revertedProgram: null,
        accountIndex: null,
        retrySafe: true,
        fix: "Fetch a fresh blockhash, re-sign, resend, confirm against the new lastValidBlockHeight. (Verify cluster too.)",
      };
      printDiagnosis(d);
      return;
    }
    // It exists in status but getTransaction returned null: likely too early.
    console.log(
      `Signature found in status (confirmations=${value.confirmations}, err=${JSON.stringify(
        value.err
      )}) but full tx not retrievable yet. Retry shortly.`
    );
    return;
  }

  if (tx.meta?.err == null) {
    console.log("Transaction SUCCEEDED. Nothing to diagnose.");
    return;
  }

  const err = tx.meta.err;
  const logs = tx.meta.logMessages ?? [];
  printDiagnosis(diagnose(err, logs, idl));
}

function printDiagnosis(d: Diagnosis) {
  console.log("DIAGNOSIS");
  console.log(`  class:        ${d.class}`);
  console.log(`  error:        ${d.errorName}`);
  console.log(`  message:      ${d.message}`);
  if (d.failingInstructionIndex !== null)
    console.log(`  instruction:  #${d.failingInstructionIndex}`);
  if (d.revertedProgram) console.log(`  reverted in:  ${d.revertedProgram}`);
  if (d.accountIndex !== null) console.log(`  account idx:  ${d.accountIndex}`);
  console.log(`  retry as-is:  ${d.retrySafe ? "YES (never executed)" : "NO"}`);
  console.log(`  fix:          ${d.fix}`);
}

main().catch((e) => {
  console.error("diagnose-signature failed:", e);
  process.exit(1);
});
