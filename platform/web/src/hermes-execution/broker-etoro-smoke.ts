import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import {
  EtoroDemoBroker,
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroReconciliationError,
  EtoroCleanupRequiredError,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { EtoroApiError, EtoroTimeoutError } from "@/lib/hermes-execution/etoro/etoro-client";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { OrderRequest } from "@/lib/hermes-execution/types";
import {
  STAGE4_EVIDENCE_SCHEMA_VERSION,
  STAGE4_EVIDENCE_TYPE,
  classifyStage4,
  type Stage4AccountModeEvidence,
  type Stage4CloseOrderSubmissionStageResult,
  type Stage4EvidenceDocument,
  type Stage4OpenOrderSubmissionStageResult,
  type Stage4ResolvedInstrumentInfo,
  type Stage4StageResult,
  type Stage4Stages,
} from "@/lib/hermes-execution/instrument-catalogue/stage4-capability-evidence";
import { checkEtoroDemoConfig, connectEtoroDemoBroker } from "./etoro-cli-shared";

// Phase 0 — Stage-4 (broker-mutation) smoke test. The ONLY file in this codebase permitted to call
// placeMarketOrder/closePosition — see stage4-capability-evidence.ts's own top-of-file note. This
// file never expands that boundary; it only now ALSO produces one formal, durable, immutable
// evidence document per run, on top of the console output/audit-log behaviour that already existed.
// See docs/project-status/ETORO_STAGE4_CAPABILITY_EVIDENCE.md for the full contract.

// Overridable only for test isolation (never touched by the real CLI invocation) — same pattern
// instrument-catalogue-cli.ts already uses, so this suite's own tests never race other suites'
// concurrent writes to the real, shared .data/hermes-execution directory.
const SMOKE_AUDIT_LOG_PATH =
  process.env.HERMES_SMOKE_AUDIT_LOG_PATH_FOR_TESTS_ONLY ?? path.join(process.cwd(), ".data", "hermes-execution", "etoro-smoke-audit-log.json");
const STAGE4_EVIDENCE_DIR =
  process.env.HERMES_STAGE4_EVIDENCE_DIR_FOR_TESTS_ONLY ?? path.join(process.cwd(), ".data", "hermes-execution", "etoro-stage4-capability-evidence");

// This smoke test only ever proves connectivity + one order lifecycle. It is not a strategy
// signal, so it is explicitly modeled as a DEMO_ONLY source — it must never be mistaken for a
// Hermes-approved trade.
const SMOKE_TEST_STRATEGY_ID = "ETORO-SMOKE-TEST";

// Named exit codes — never a bare magic number. See docs/project-status/
// ETORO_STAGE4_CAPABILITY_EVIDENCE.md's own "Exit codes" section for the full map.
const EXIT_CODES = {
  VERIFIED: 0,
  CONFIGURATION_FAILURE: 1,
  RESOLUTION_FAILURE: 2,
  QUOTE_FAILURE: 3,
  OPEN_SUBMISSION_FAILURE: 4,
  OPEN_CONFIRMATION_FAILURE: 5,
  CLOSE_SUBMISSION_FAILURE: 6,
  CLOSE_CONFIRMATION_FAILURE: 7,
  INDETERMINATE: 8,
  EVIDENCE_WRITE_FAILURE: 9,
  UNEXPECTED_FAILURE: 10,
} as const;
type ExitCodeName = keyof typeof EXIT_CODES;

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same defence-in-depth redaction as etoro-instrument-probe.ts's own copy — deliberately
 * duplicated, never imported, since a top-level CLI script never depends on another one. */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactDeep<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") return redactSecrets(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, secrets)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      result[key] = redactDeep(nested, secrets);
    }
    return result as unknown as T;
  }
  return value;
}

function tryGetGitCommit(): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf-8", timeout: 2_000 }).trim();
  } catch {
    return undefined;
  }
}

async function tryGetAppVersion(): Promise<string> {
  try {
    const text = await fs.readFile(path.join(process.cwd(), "package.json"), "utf-8");
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch {
    return "unknown";
  }
}

export class Stage4EvidenceWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage4EvidenceWriteError";
  }
}

/**
 * Atomic, create-only write. Writes to a unique temp file, fsyncs it, then fs.link()s it into the
 * final destination — link() fails with EEXIST if that destination already exists, so an evidence
 * file for a given runId+instrument is NEVER silently overwritten (a rename would happily replace
 * an existing file; link() structurally cannot). The destination therefore is always either absent
 * or one complete, fsynced document — never a partially-written file, and never a second run's
 * result quietly clobbering the first's.
 *
 * Portability note: tempPath and filePath are always constructed in the SAME directory, so they are
 * always on the same volume/filesystem — fs.link() can never fail with EXDEV (cross-device link)
 * here. The only remaining portability risk is a filesystem under STAGE4_EVIDENCE_DIR that doesn't
 * support hard links at all (rare — e.g. some FAT-family filesystems); on such a filesystem this
 * function fails honestly with Stage4EvidenceWriteError rather than silently falling back to a
 * rename-based (overwrite-capable) write, which would reopen the exact risk this design prevents.
 */
async function writeStage4EvidenceFile(doc: Stage4EvidenceDocument, secrets: readonly string[]): Promise<string> {
  await fs.mkdir(STAGE4_EVIDENCE_DIR, { recursive: true });
  const fileName = `${doc.runId}__${doc.requestedInstrument}.json`;
  const filePath = path.join(STAGE4_EVIDENCE_DIR, fileName);
  const sanitizedDoc = redactDeep(doc as unknown as Record<string, unknown>, secrets);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;

  let handle: FileHandle;
  try {
    handle = await fs.open(tempPath, "w");
  } catch (error) {
    throw new Stage4EvidenceWriteError(`could not create temp evidence file: ${toErrorMessage(error)}`);
  }
  try {
    await handle.writeFile(JSON.stringify(sanitizedDoc, null, 2), "utf-8");
    await handle.sync();
  } catch (error) {
    await handle.close();
    await fs.rm(tempPath, { force: true });
    throw new Stage4EvidenceWriteError(`could not write temp evidence file: ${toErrorMessage(error)}`);
  }
  await handle.close();

  try {
    await fs.link(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Stage4EvidenceWriteError(`an evidence file already exists for runId "${doc.runId}" — refusing to overwrite: ${filePath}`);
    }
    throw new Stage4EvidenceWriteError(`could not finalise evidence file: ${toErrorMessage(error)}`);
  }
  // The link succeeded — filePath and tempPath are now two names for the same complete, fsynced
  // content. Only the temp name is redundant past this point; never leave it behind.
  await fs.rm(tempPath, { force: true });
  return filePath;
}

function notRun(): Stage4StageResult {
  return { status: "NOT_RUN", detail: "not attempted" };
}

function createInitialStage4Stages(): Stage4Stages {
  return {
    resolution: notRun(),
    quote: notRun(),
    openOrderSubmission: notRun(),
    openPositionConfirmation: notRun(),
    closeOrderSubmission: notRun(),
    closedPositionConfirmation: notRun(),
  };
}

function describeResolutionFailure(error: unknown): string {
  if (error instanceof EtoroNoInstrumentMatchError || error instanceof EtoroAmbiguousInstrumentError) {
    return error.message;
  }
  return `Instrument resolution failed: ${toErrorMessage(error)}`;
}

function describeQuoteFailure(error: unknown, displayName: string, instrumentId: number): string {
  if (error instanceof EtoroRateUnavailableError) {
    const detail = error.reason === "absent" ? "it was absent from eToro's rates response entirely" : "eToro returned a rate entry for it but with no usable bid/ask";
    return `No rate data available for ${displayName} (instrumentId=${instrumentId}) — ${detail}. Interpreting this as the market currently being closed or pricing temporarily unavailable.`;
  }
  return `Rate retrieval failed: ${toErrorMessage(error)}`;
}

/**
 * EtoroReconciliationError/EtoroTimeoutError both mean "a mutating request was sent and its
 * outcome could not be confidently determined" — the broker's real state may or may not have
 * changed, so neither is ever reported as a definitive FAILED. Only EtoroApiError (the server
 * itself explicitly rejected the request) is definitive enough to call FAILED.
 */
function describeOpenSubmissionFailure(error: unknown, requestedNotional: number, elapsedMs: number): Stage4OpenOrderSubmissionStageResult {
  if (error instanceof EtoroReconciliationError) {
    return {
      status: "INDETERMINATE",
      detail: `Open order outcome could not be reconciled to exactly one position (${error.reason}): ${error.message}`,
      elapsedMs,
      requestedNotional,
    };
  }
  if (error instanceof EtoroTimeoutError) {
    return { status: "INDETERMINATE", detail: `Open order submission timed out — broker state cannot be assumed unchanged: ${error.message}`, elapsedMs, requestedNotional };
  }
  if (error instanceof EtoroApiError) {
    return { status: "FAILED", detail: `Open order submission was definitively rejected by eToro: ${error.message}`, elapsedMs, requestedNotional };
  }
  return {
    status: "INDETERMINATE",
    detail: `Open order submission failed with an unexpected error — broker state cannot be assumed unchanged: ${toErrorMessage(error)}`,
    elapsedMs,
    requestedNotional,
  };
}

/** Same conservative default-to-INDETERMINATE reasoning as describeOpenSubmissionFailure above. */
function describeCloseSubmissionFailure(error: unknown, brokerPositionId: string | undefined, elapsedMs: number): Stage4CloseOrderSubmissionStageResult {
  if (error instanceof EtoroCleanupRequiredError) {
    return { status: "INDETERMINATE", detail: `Close request outcome is uncertain, cleanup may be required: ${error.message}`, elapsedMs, brokerPositionId };
  }
  if (error instanceof EtoroTimeoutError) {
    return { status: "INDETERMINATE", detail: `Close order submission timed out — broker state cannot be assumed unchanged: ${error.message}`, elapsedMs, brokerPositionId };
  }
  if (error instanceof EtoroApiError) {
    return { status: "FAILED", detail: `Close order submission was definitively rejected by eToro: ${error.message}`, elapsedMs, brokerPositionId };
  }
  return {
    status: "INDETERMINATE",
    detail: `Close order submission failed with an unexpected error — broker state cannot be assumed unchanged: ${toErrorMessage(error)}`,
    elapsedMs,
    brokerPositionId,
  };
}

/** Names the exit code after the exit-code map above; never a magic number. */
function exitCodeNameFor(classification: "VERIFIED" | "FAILED" | "INDETERMINATE", stages: Stage4Stages): ExitCodeName {
  if (classification === "VERIFIED") return "VERIFIED";
  if (classification === "INDETERMINATE") return "INDETERMINATE";
  if (stages.resolution.status === "FAILED") return "RESOLUTION_FAILURE";
  if (stages.quote.status === "FAILED") return "QUOTE_FAILURE";
  if (stages.openOrderSubmission.status === "FAILED") return "OPEN_SUBMISSION_FAILURE";
  if (stages.openPositionConfirmation.status === "FAILED") return "OPEN_CONFIRMATION_FAILURE";
  if (stages.closeOrderSubmission.status === "FAILED") return "CLOSE_SUBMISSION_FAILURE";
  if (stages.closedPositionConfirmation.status === "FAILED") return "CLOSE_CONFIRMATION_FAILURE";
  // classifyStage4 said FAILED but no individual stage agrees — a defensive inconsistency this
  // process cannot explain safely, never silently mapped to a specific stage's code.
  return "UNEXPECTED_FAILURE";
}

export async function main(): Promise<void> {
  console.log("eToro Demo Broker — Stage 4 Smoke Test");
  console.log("=======================================");
  console.log("WARNING: this command OPENS and CLOSES one real eToro DEMO position. It never");
  console.log("reaches a live route, but it does mutate demo broker state.");

  const runId = `smoke-etoro-${Date.now()}`;
  console.log(`Execution run id: ${runId}`);

  // Stage 0: validate demo-only configuration — identical checks/order to before this change.
  const config = getHermesExecutionConfig();
  console.log("Broker provider: etoro-demo (fixed for this command — BROKER_PROVIDER is not consulted)");

  const demoConfigCheck = checkEtoroDemoConfig(config);
  if (!demoConfigCheck.ok) {
    console.error(demoConfigCheck.reason);
    process.exitCode = EXIT_CODES.CONFIGURATION_FAILURE;
    return;
  }
  if (!config.etoro.testInstrument.trim()) {
    console.error("ETORO_DEMO_TEST_INSTRUMENT must be a non-empty search term.");
    process.exitCode = EXIT_CODES.CONFIGURATION_FAILURE;
    return;
  }
  if (config.etoro.testAmount === undefined || !Number.isFinite(config.etoro.testAmount) || config.etoro.testAmount <= 0) {
    console.error("ETORO_DEMO_TEST_AMOUNT must be set to a positive finite number.");
    process.exitCode = EXIT_CODES.CONFIGURATION_FAILURE;
    return;
  }
  console.log("Configuration valid (demo-only, no live route reachable).");

  // In-memory run record, created before any broker connection is attempted (evidence-write-timing
  // requirement) — every field below is mutated in place as each stage completes, and is what the
  // finally block below persists regardless of how/where this function returns.
  const requestedInstrument = config.etoro.testInstrument;
  const startedAt = new Date().toISOString();
  const stages = createInitialStage4Stages();
  const accountModeEvidence: Stage4AccountModeEvidence = {
    configuredProvider: "etoro-demo",
    demoOnlyGuardPassed: true, // the two checks above already passed, or this line is unreached.
    liveRouteReachable: false, // no eToro CLI tool in this codebase ever constructs a live-route client.
  };
  let resolvedInstrument: Stage4ResolvedInstrumentInfo | null = null;
  const secrets = [config.etoro.apiKey, config.etoro.userKey].filter((s): s is string => typeof s === "string" && s.length > 0);
  const gitCommit = tryGetGitCommit();
  const appVersion = await tryGetAppVersion();

  let broker: EtoroDemoBroker | undefined;
  let brokerPositionId: string | undefined;

  // Everything from here on — including creating the audit trail itself — is inside try/finally,
  // so ANY exception (not just a per-stage-anticipated one) still reaches the evidence-write
  // finalisation below. An audit-trail I/O failure is instrument-adjacent enough to attribute to
  // the resolution stage (nothing instrument-specific was reached before it either), same as a
  // connect failure.
  try {
    const connectStart = Date.now();
    let auditTrail: JsonFileAuditTrail;
    try {
      auditTrail = await JsonFileAuditTrail.createFresh(SMOKE_AUDIT_LOG_PATH);
      broker = await connectEtoroDemoBroker(config, auditTrail, runId);
      console.log("Connected to eToro (credentials verified via demo portfolio read).");
    } catch (error) {
      stages.resolution = { status: "FAILED", detail: `Failed to connect to eToro Demo: ${toErrorMessage(error)}`, elapsedMs: Date.now() - connectStart };
      console.error(stages.resolution.detail);
      return;
    }

    // Stage 1: resolution.
    const resolutionStart = Date.now();
    let resolved: Awaited<ReturnType<EtoroDemoBroker["resolveInstrument"]>>;
    try {
      resolved = await broker.resolveInstrument(requestedInstrument);
    } catch (error) {
      stages.resolution = { status: "FAILED", detail: describeResolutionFailure(error), elapsedMs: Date.now() - resolutionStart };
      console.error(stages.resolution.detail);
      return;
    }
    resolvedInstrument = {
      symbol: resolved.symbol,
      displayName: resolved.displayName,
      brokerInstrumentId: resolved.instrumentId,
      instrumentTypeID: resolved.instrumentTypeID ?? null,
      exchangeID: resolved.exchangeID ?? null,
    };
    stages.resolution = {
      status: "SUCCEEDED",
      detail: `Resolved ${resolved.displayName} (${resolved.symbol})`,
      elapsedMs: Date.now() - resolutionStart,
      brokerInstrumentId: resolved.instrumentId,
    };
    console.log(`Resolved instrument: ${resolved.displayName} (${resolved.symbol}), instrumentId=${resolved.instrumentId}`);

    // Stage 2: quote.
    const quoteStart = Date.now();
    let openRate: Awaited<ReturnType<EtoroDemoBroker["getRate"]>>;
    try {
      openRate = await broker.getRate(requestedInstrument);
    } catch (error) {
      stages.quote = { status: "FAILED", detail: describeQuoteFailure(error, resolved.displayName, resolved.instrumentId), elapsedMs: Date.now() - quoteStart };
      console.error(stages.quote.detail);
      return;
    }
    stages.quote = { status: "SUCCEEDED", detail: `bid=${openRate.bid}, ask=${openRate.ask}`, elapsedMs: Date.now() - quoteStart, bid: openRate.bid, ask: openRate.ask };
    console.log(`Current rate: bid=${openRate.bid}, ask=${openRate.ask}`);

    const amount = config.etoro.testAmount;
    console.log(`Proposed order: BUY ${resolved.symbol}, amount=${amount} (currency=usd), leverage=1 (fixed, no leverage)`);

    const orderRequest: OrderRequest = {
      strategyId: SMOKE_TEST_STRATEGY_ID,
      strategyVersion: 1,
      sourceType: "DEMO_ONLY",
      instrument: requestedInstrument,
      side: "BUY",
      quantity: amount,
      price: openRate.ask,
      timestamp: new Date().toISOString(),
    };

    // Stage 3: open order submission.
    const openStart = Date.now();
    let positionId: string;
    try {
      const result = await broker.placeMarketOrder(orderRequest);
      positionId = result.position.positionId;
      brokerPositionId = result.position.brokerPositionId;
      stages.openOrderSubmission = {
        status: "SUCCEEDED",
        detail: `Order accepted: orderId=${result.orderId}, entryPrice=${result.position.entryPrice}`,
        elapsedMs: Date.now() - openStart,
        requestedNotional: amount,
        brokerOrderId: result.orderId,
        brokerPositionId,
      };
      console.log(`Order accepted: orderId=${result.orderId}, entryPrice=${result.position.entryPrice}, amount=${result.position.quantity}`);
    } catch (error) {
      stages.openOrderSubmission = describeOpenSubmissionFailure(error, amount, Date.now() - openStart);
      console.error(stages.openOrderSubmission.detail);
      return;
    }

    // Stage 4: open position confirmation — this smoke test's OWN independent re-check (mirrors
    // the old tool's Stage 9: placeMarketOrder already reconciled internally, this re-confirms via
    // the shared PaperBroker interface).
    const confirmOpenStart = Date.now();
    const openAfterOrder = broker.getOpenPositions().some((p) => p.positionId === positionId);
    if (!openAfterOrder) {
      stages.openPositionConfirmation = {
        status: "INDETERMINATE",
        detail: `Position ${positionId} not found among this broker instance's tracked positions after ordering — open state cannot be confirmed.`,
        elapsedMs: Date.now() - confirmOpenStart,
        brokerPositionId,
      };
      console.error(stages.openPositionConfirmation.detail);
      return;
    }
    stages.openPositionConfirmation = {
      status: "SUCCEEDED",
      detail: `Confirmed: position ${positionId} is open in the demo portfolio.`,
      elapsedMs: Date.now() - confirmOpenStart,
      brokerPositionId,
      confirmedAt: new Date().toISOString(),
    };
    console.log(stages.openPositionConfirmation.detail);

    // Stage 5: close order submission.
    const closeStart = Date.now();
    try {
      const closeRate = await broker.getRate(requestedInstrument);
      const closeResult = await broker.closePosition(positionId, closeRate.bid, new Date().toISOString(), "smoke-test-cleanup");
      stages.closeOrderSubmission = {
        status: "SUCCEEDED",
        detail: `Position closed: orderId=${closeResult.orderId}, exitPrice=${closeResult.trade.exitPrice}, realisedPnl=${closeResult.trade.realisedPnl.toFixed(4)}`,
        elapsedMs: Date.now() - closeStart,
        brokerPositionId,
        brokerCloseOrderId: closeResult.orderId,
      };
      console.log(stages.closeOrderSubmission.detail);
    } catch (error) {
      stages.closeOrderSubmission = describeCloseSubmissionFailure(error, brokerPositionId, Date.now() - closeStart);
      console.error(stages.closeOrderSubmission.detail);
      return;
    }

    // Stage 6: closed position confirmation — this smoke test's OWN independent re-check.
    const confirmCloseStart = Date.now();
    const stillOpen = broker.getOpenPositions().some((p) => p.positionId === positionId);
    if (stillOpen) {
      stages.closedPositionConfirmation = {
        status: "INDETERMINATE",
        detail: `Position ${positionId} still appears open after closing — manual intervention required.`,
        elapsedMs: Date.now() - confirmCloseStart,
        brokerPositionId,
      };
      console.error(stages.closedPositionConfirmation.detail);
      return;
    }
    stages.closedPositionConfirmation = {
      status: "SUCCEEDED",
      detail: "Confirmed: no smoke-test position remains open.",
      elapsedMs: Date.now() - confirmCloseStart,
      brokerPositionId,
      confirmedAt: new Date().toISOString(),
    };
    console.log(stages.closedPositionConfirmation.detail);
  } finally {
    // Guaranteed to run regardless of which `return` above (or an unexpected exception) exited the
    // block — an evidence document is always ATTEMPTED, using whatever stage results were actually
    // recorded, never a partial run silently producing no evidence at all.
    const completedAt = new Date().toISOString();
    const accountModeConfirmed = accountModeEvidence.demoOnlyGuardPassed && !accountModeEvidence.liveRouteReachable;
    const { classification, reasons } = classifyStage4(stages, accountModeConfirmed);

    const doc: Stage4EvidenceDocument = {
      schemaVersion: STAGE4_EVIDENCE_SCHEMA_VERSION,
      evidenceType: STAGE4_EVIDENCE_TYPE,
      runId,
      startedAt,
      completedAt,
      gitCommit,
      appVersion,
      brokerProvider: "etoro-demo",
      requestedInstrument,
      resolvedInstrument,
      accountModeEvidence,
      stages,
      finalClassification: classification,
      classificationReasons: reasons,
      limitations: ["Stage 4 opens and closes exactly one real eToro DEMO position per run — never a live position, never more than one position."],
      evidenceGeneratedAt: completedAt,
    };

    console.log("");
    console.log(`Stage-4 classification: ${classification}`);
    if (reasons.length > 0) console.log(`Reasons: ${reasons.join(", ")}`);
    if (classification === "INDETERMINATE") {
      // Every INDETERMINATE path gets this SAME explicit, operator-facing instruction — never left
      // to each stage's own detail text to (inconsistently) mention it.
      console.log(
        `MANUAL INSPECTION RECOMMENDED: broker state could not be confirmed${brokerPositionId ? ` (broker position id: ${brokerPositionId})` : ""} — ` +
          "check the eToro demo portfolio directly for an unexpected open position before re-running.",
      );
    }

    process.exitCode = EXIT_CODES[exitCodeNameFor(classification, stages)];

    try {
      const evidenceFile = await writeStage4EvidenceFile(doc, secrets);
      console.log(`Evidence written: ${evidenceFile}`);
    } catch (error) {
      // The broker operation(s) above (if any) genuinely occurred as described — an evidence-write
      // failure must never be reported as if it were itself a broker-side failure, and must never
      // silently swallow the classification already determined above.
      console.error(
        `WARNING: the Stage-4 broker operation(s) above completed as described, but durable evidence was NOT written: ${toErrorMessage(error)}`,
      );
      // Precedence: an unresolved broker-state ambiguity is the single most operationally important
      // signal this process can emit — it must never be masked by a secondary I/O problem. Only
      // when the broker-side result is already known-safe (VERIFIED) or known-clean (FAILED, i.e.
      // "nothing happened") does the evidence-write failure become the more actionable exit code.
      if (classification !== "INDETERMINATE") {
        process.exitCode = EXIT_CODES.EVIDENCE_WRITE_FAILURE;
      }
    }

    console.log(`STAGE-4 SMOKE TEST OUTCOME: ${classification}`);
  }
}

// Only auto-runs when this file is executed directly (`tsx broker-etoro-smoke.ts`), not when
// imported elsewhere (e.g. its own test file, which imports `main` and calls it explicitly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("eToro Stage-4 smoke test crashed unexpectedly:", error instanceof Error ? error.message : error);
    process.exitCode = EXIT_CODES.UNEXPECTED_FAILURE;
  });
}
