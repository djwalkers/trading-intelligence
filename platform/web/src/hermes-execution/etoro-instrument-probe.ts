import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import {
  EtoroNoInstrumentMatchError,
  EtoroAmbiguousInstrumentError,
  EtoroRateUnavailableError,
  EtoroCandleHistoryUnavailableError,
  type EtoroResolvedInstrument,
} from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import { validateHistoricalCandles, diagnoseCandleGaps, type MarketTimeframe } from "@/lib/hermes-execution/market-data/candle-validation";
import type { RawRateFieldInspection } from "@/lib/hermes-execution/etoro/etoro-quote-diagnostics";
import type { Candle } from "@/lib/hermes-execution/types";
import { checkEtoroDemoConfig, connectEtoroDemoBroker } from "./etoro-cli-shared";

// Phase 0 — eToro Instrument Capability Probe (read-only Stages 1-3). See
// docs/project-status/ETORO_INSTRUMENT_CAPABILITY_PLAN.md for the full plan this implements.
//
// This tool NEVER places, closes, or alters a broker order, and never touches approval/execution/
// risk/lifecycle state. It only ever calls resolveInstrument()/getRate()/getHistoricalCandles(),
// all read-only — see EtoroReadOnlyProbeBroker below, the narrow interface this file's own code is
// typed against for everything past the initial connect() call, so this file cannot even reference
// placeMarketOrder/closePosition/etc. without a type error, regardless of what the real
// EtoroDemoBroker instance underneath happens to also expose. Stage 4 (the only stage that touches
// broker state) remains broker-etoro-smoke.ts's own, separate, explicit-approval-gated job.
//
// Evidence — two complementary layers, never one file trying to serve both jobs:
//  1. One immutable, self-contained JSON document per run+instrument under EVIDENCE_DIR — the
//     primary artifact, meant for later instrument-catalogue ingestion, side-by-side comparison
//     across runs, and standalone export. Contains runId, start/end timestamps, git commit,
//     application version, the safe (non-secret) configuration used, every stage's full outcome,
//     and the final classification. Written via JsonFileAuditTrail.createFresh — never appended to
//     again once written, and naturally left in place (not silently completed) if the process
//     crashes mid-run, so a partial run is always honestly visible as "some instruments have an
//     evidence file, some don't" rather than one ambiguous shared log.
//  2. A lightweight, append-only, cross-run pointer log at PROBE_LOG_PATH (unchanged from the
//     original design) — every stage attempt still lands here in real time (useful for tailing a
//     live run), and the final per-instrument event additionally carries `evidenceFile`, pointing
//     at document (1) above.

const EVIDENCE_DIR = path.join(process.cwd(), ".data", "hermes-execution", "etoro-capability-evidence");
const PROBE_LOG_PATH = path.join(process.cwd(), ".data", "hermes-execution", "etoro-instrument-probe-log.json");

// Plan §11 — no eToro-specific rate-limit handling exists anywhere in the adapter today, so this
// tool is conservative by convention: instruments are probed strictly sequentially (never in
// parallel), with a deliberate pause between each. The same constant doubles as the transport-error
// retry delay (plan §9) — both are "wait a bit before hitting eToro again," never combined into a
// single request burst.
const INTER_INSTRUMENT_PAUSE_MS = 1_500;

// Plan §3 — "Freshness check: compare the quote's own timestamp... against wall-clock time; flag
// as stale if the gap exceeds a short threshold (recommend 60 seconds)."
const QUOTE_STALENESS_THRESHOLD_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Defence-in-depth only — every thrown error this file ever persists (EtoroApiError/
 * EtoroTimeoutError/EtoroRateUnavailableError/etc.) is already documented as deliberately
 * credential-free (see etoro-client.ts's own EtoroApiError/EtoroTimeoutError doc comments: "never
 * the URL, headers, or body"). This exists purely as a second, structural guarantee: the two actual
 * secret values (apiKey/userKey) are stripped from any text before it is ever written to evidence or
 * the audit log, so even a future, unreviewed change to an error message upstream could never leak
 * one through this tool.
 */
function redactSecrets(text: string, secrets: readonly string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/** Applies redactSecrets to every string value anywhere in an arbitrarily-nested plain
 * object/array (audit `details` payloads, evidence documents) — deliberately generic rather than
 * naming specific fields (`message`, `detail`, ...) one at a time, so a future field this file adds
 * can never accidentally bypass redaction by using a different key name. */
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

/** The only broker capability surface this file's own code can reference — deliberately missing
 * placeMarketOrder/closePosition/getOpenPositions/getAccount/getRawPortfolio/adoptPosition and
 * everything else EtoroDemoBroker exposes. `connectEtoroDemoBroker` still returns the full,
 * concrete EtoroDemoBroker (broker-etoro-smoke.ts's Stage 4 needs the wider surface) — this file
 * narrows the value to this interface the moment it's connected (see main()), so every line past
 * that point is type-checked against read-only methods only. `getRateFieldDiagnostics` is itself
 * still read-only (one more GET .../rates call) — included here only so the opt-in
 * `--diagnose-quote-fields` flag can reach it; the default probe run never calls it. */
export interface EtoroReadOnlyProbeBroker {
  resolveInstrument(searchTerm: string): Promise<EtoroResolvedInstrument>;
  getRate(instrument: string): Promise<{ bid: number; ask: number; date?: string }>;
  getHistoricalCandles(instrument: string, timeframe: MarketTimeframe, count: number): Promise<Candle[]>;
  getRateFieldDiagnostics(instrument: string): Promise<RawRateFieldInspection>;
}

export type ResolutionOutcome =
  | { kind: "success"; resolved: EtoroResolvedInstrument }
  | { kind: "no-match" }
  | { kind: "ambiguous"; candidateCount: number }
  | { kind: "transport-error"; message: string };

// Live-BTC-run remediation (probe-etoro-1785446881512 classification defect). Four distinct,
// honestly-named states — never collapsed into a single "stale: boolean" flag again:
//  - FRESH: a quote timestamp was returned, parsed cleanly, and its age is within threshold.
//  - STALE: a quote timestamp was returned and parsed cleanly, but its age exceeds threshold.
//  - INVALID_TIMESTAMP: a quote timestamp was returned but could not be parsed at all.
//  - UNKNOWN: no quote timestamp was returned. eToro's rate response `date` field is the ONLY
//    signal this tool has for how old the underlying price is — there is no separately trustworthy
//    receipt timestamp in this adapter's contract (the probe's own `probeReceivedAt` only proves
//    WE made a fresh HTTP call, never that the price itself is current). A missing timestamp is
//    therefore never treated as fresh, and is recorded as UNKNOWN, not FRESH.
export type QuoteFreshness = "FRESH" | "STALE" | "INVALID_TIMESTAMP" | "UNKNOWN";

export type QuoteOutcome =
  | {
      kind: "success";
      // Preserves raw retrieval success (a valid, finite, non-inverted bid/ask was returned)
      // as a fact distinct from whether that quote is USABLE for Stage 2 verification —
      // `usableForVerification` is the one field classify() and the catalogue must ever gate on,
      // never `kind` alone.
      retrievalSucceeded: true;
      bid: number;
      ask: number;
      spread: number;
      /** eToro's own rate-response timestamp, verbatim, or undefined if it returned none. */
      date: string | undefined;
      /** This probe's own wall-clock capture time — proves when WE received the response, never
       * how current the underlying price is (see QuoteFreshness's own doc comment). */
      probeReceivedAt: string;
      /** Only defined when `date` was present and parsed cleanly. */
      ageSeconds: number | undefined;
      freshness: QuoteFreshness;
      /** True only when freshness === "FRESH" — the single field READ_ONLY_VERIFIED gates on. */
      usableForVerification: boolean;
    }
  // A rate WAS returned but is not genuinely usable (non-finite/non-positive, or ask < bid) — a
  // distinct, conclusive negative result, never silently accepted as "success" (plan §6 requirement
  // 4: invalid data must never read as verified).
  | { kind: "malformed"; bid: number; ask: number; reason: string }
  | { kind: "unavailable"; reason: "absent" | "unpriced" }
  | { kind: "transport-error"; message: string };

export type CandleOutcome =
  | { kind: "success"; candleCount: number; firstTimestamp: string; lastTimestamp: string; lastCandleAgeSeconds: number }
  | { kind: "unavailable"; reason: "absent" | "empty" }
  | { kind: "invalid"; message: string; gapCount: number }
  | { kind: "transport-error"; message: string };

// Mirrors the plan's own five-state classification (§6), minus VERIFIED — that status is reserved
// for a successful Stage 4 demo execution (broker-etoro-smoke.ts) and is never assigned by this
// read-only tool, no matter how clean Stages 1-3 come back.
export type Classification = "NOT_TESTED" | "UNSUPPORTED" | "PARTIALLY_SUPPORTED" | "READ_ONLY_VERIFIED";

interface InstrumentProbeResult {
  instrument: string;
  resolution: ResolutionOutcome;
  quote?: QuoteOutcome;
  candles?: CandleOutcome;
  classification: Classification;
  classificationReasons: string[];
  quoteFieldDiagnostics?: RawRateFieldInspection;
}

/** The non-secret configuration snapshot captured into every evidence document — never apiKey/
 * userKey. `currency` is always `null`: no eToro response (search/rates/portfolio) reports a
 * per-instrument settlement currency anywhere (see ETORO_INSTRUMENT_CAPABILITY_PLAN.md §3/§4) — this
 * makes that "genuinely unresolved" state an explicit, visible fact in every evidence document,
 * never an assumed "usd" that isn't actually broker-confirmed. */
interface ProbeConfiguration {
  brokerProvider: "etoro-demo";
  timeframe: MarketTimeframe;
  requestedCandleCount: number;
  maxCandleAgeSeconds: number;
  quoteStalenessThresholdMs: number;
  currency: null;
}

// Live-BTC-run remediation. Bumped from 1 -> 2: schemaVersion 1 documents (e.g.
// probe-etoro-1785446881512) predate the QuoteOutcome freshness fix and may contain a stale quote
// misclassified as READ_ONLY_VERIFIED — a future catalogue-ingestion safeguard can reject/flag
// schemaVersion 1 rows outright rather than re-deriving trust from their own (possibly wrong)
// classification field. Building that ingestion/rejection logic is explicitly out of scope here.
const EVIDENCE_SCHEMA_VERSION = 2;

interface InstrumentEvidenceDocument {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  runId: string;
  instrument: string;
  startedAt: string;
  completedAt: string;
  gitCommit: string | undefined;
  appVersion: string;
  configuration: ProbeConfiguration;
  resolution: ResolutionOutcome;
  quote: QuoteOutcome | undefined;
  candles: CandleOutcome | undefined;
  classification: Classification;
  /** Machine-readable codes explaining why `classification` isn't READ_ONLY_VERIFIED — always
   * empty when it is. See classificationReasons()'s own doc comment. */
  classificationReasons: string[];
  /** Only present when this run was invoked with `--diagnose-quote-fields` AND resolution
   * succeeded. Quote-timestamp-semantics investigation — see etoro-quote-diagnostics.ts's own
   * top-of-file comment. Never influences `classification` itself. */
  quoteFieldDiagnostics: RawRateFieldInspection | undefined;
}

interface ProbeDeps {
  broker: EtoroReadOnlyProbeBroker;
  auditTrail: JsonFileAuditTrail;
  executionRunId: string;
  timeframe: MarketTimeframe;
  candleCount: number;
  maxCandleAgeSeconds: number;
  secrets: readonly string[];
  /** Opt-in only (`--diagnose-quote-fields`) — never enabled by a default probe run. See
   * EtoroDemoBroker.getRateFieldDiagnostics's own doc comment for why this issues a second,
   * separate eToro call when enabled. */
  diagnoseQuoteFields: boolean;
}

async function recordStageResult(
  deps: ProbeDeps,
  instrument: string,
  stage: "resolution" | "quote" | "candles",
  details: Record<string, unknown>,
): Promise<void> {
  const sanitized = redactDeep(details, deps.secrets);
  await deps.auditTrail.record({
    timestamp: new Date().toISOString(),
    eventType: "INSTRUMENT_PROBE_STAGE_RESULT",
    executionRunId: deps.executionRunId,
    instrument,
    details: { stage, ...sanitized },
  });
}

/**
 * Stage 1 — resolution only. Calls EtoroDemoBroker.resolveInstrument (existing code, unmodified)
 * and classifies the result using the adapter's own, already-distinct error taxonomy (never
 * collapsed into one generic "failed" bucket) — plan §2. A transport error (anything other than the
 * two named resolution errors — e.g. EtoroApiError, including an authentication failure, or a
 * timeout) is retried once before being accepted as inconclusive, per plan §9/§11: "must be retried
 * at least once... never conflated with the first attempt." Crucially, a transport/auth/timeout
 * failure is classified as NOT_TESTED, never UNSUPPORTED — this function never treats "the request
 * itself failed" as evidence about the instrument.
 */
async function probeResolution(deps: ProbeDeps, instrument: string, attempt = 1): Promise<ResolutionOutcome> {
  try {
    const resolved = await deps.broker.resolveInstrument(instrument);
    await recordStageResult(deps, instrument, "resolution", {
      outcome: "success",
      attempt,
      instrumentId: resolved.instrumentId,
      instrumentTypeID: resolved.instrumentTypeID,
      exchangeID: resolved.exchangeID,
      displayName: resolved.displayName,
      resolvedSymbol: resolved.symbol,
    });
    return { kind: "success", resolved };
  } catch (error) {
    if (error instanceof EtoroNoInstrumentMatchError) {
      await recordStageResult(deps, instrument, "resolution", { outcome: "failure", attempt, reason: "no-match", message: error.message });
      return { kind: "no-match" };
    }
    if (error instanceof EtoroAmbiguousInstrumentError) {
      await recordStageResult(deps, instrument, "resolution", {
        outcome: "failure",
        attempt,
        reason: "ambiguous",
        message: error.message,
        candidates: error.candidates.map((c) => ({
          instrumentId: c.instrumentID,
          displayName: c.instrumentDisplayName,
          symbol: c.symbolFull,
          instrumentTypeID: c.instrumentTypeID,
          exchangeID: c.exchangeID,
        })),
      });
      return { kind: "ambiguous", candidateCount: error.candidates.length };
    }
    const message = toErrorMessage(error);
    await recordStageResult(deps, instrument, "resolution", { outcome: "failure", attempt, reason: "transport-error", message });
    if (attempt === 1) {
      await sleep(INTER_INSTRUMENT_PAUSE_MS);
      return probeResolution(deps, instrument, 2);
    }
    return { kind: "transport-error", message: redactSecrets(message, deps.secrets) };
  }
}

/**
 * Stage 2 — live quote. Calls EtoroDemoBroker.getRate (existing code, unmodified), then applies
 * this tool's OWN finite/positive/non-inverted validation — getRate() itself only distinguishes
 * "absent" from "present but missing bid/ask" (EtoroRateUnavailableError); it does not check for
 * NaN, zero/negative, or an inverted (ask < bid) rate the way LiveMarketDataProvider does for the
 * real trading path. A rate that IS returned but fails this check is recorded as "malformed", a
 * distinct, conclusive negative result — never "success". Plan §3: no eToro response field confirms
 * market-open status at all — an unavailable rate is recorded honestly as "unavailable", discussed
 * only as a *possible* market-closed inference in the printed summary, never a confirmed fact. A
 * date that fails to parse is recorded as `dateParseError: true`, never silently treated the same as
 * "no timestamp was returned at all".
 */
async function probeQuote(deps: ProbeDeps, instrument: string, attempt = 1): Promise<QuoteOutcome> {
  try {
    const rate = await deps.broker.getRate(instrument);
    const probeReceivedAt = new Date().toISOString();

    if (!Number.isFinite(rate.bid) || !Number.isFinite(rate.ask) || rate.bid <= 0 || rate.ask <= 0) {
      const reason = `non-finite or non-positive rate: bid=${rate.bid}, ask=${rate.ask}`;
      await recordStageResult(deps, instrument, "quote", { outcome: "failure", attempt, reason: "malformed", detail: reason });
      return { kind: "malformed", bid: rate.bid, ask: rate.ask, reason };
    }
    if (rate.ask < rate.bid) {
      const reason = `inverted rate: ask=${rate.ask} is below bid=${rate.bid}`;
      await recordStageResult(deps, instrument, "quote", { outcome: "failure", attempt, reason: "malformed", detail: reason });
      return { kind: "malformed", bid: rate.bid, ask: rate.ask, reason };
    }

    // Live-BTC-run remediation. Freshness is now a first-class, four-state fact — never a bare
    // boolean derived only when a timestamp happens to parse. A missing timestamp is UNKNOWN, not
    // FRESH (see QuoteFreshness's own doc comment); only FRESH is usable for verification.
    let ageSeconds: number | undefined;
    let freshness: QuoteFreshness;
    if (rate.date === undefined) {
      freshness = "UNKNOWN";
    } else {
      const parsedMs = Date.parse(rate.date);
      if (!Number.isFinite(parsedMs)) {
        freshness = "INVALID_TIMESTAMP";
      } else {
        ageSeconds = Math.max(0, (Date.now() - parsedMs) / 1000);
        freshness = ageSeconds * 1000 > QUOTE_STALENESS_THRESHOLD_MS ? "STALE" : "FRESH";
      }
    }
    const usableForVerification = freshness === "FRESH";

    // `outcome` here is deliberately gated on usableForVerification, not merely "a rate came
    // back" — this is the exact field a naive reader of the cross-run pointer log would scan for
    // "did Stage 2 pass," and a stale/unparseable/missing-timestamp quote must never read as
    // "success" there, even though QuoteOutcome.kind itself stays "success" (retrieval succeeded).
    await recordStageResult(deps, instrument, "quote", {
      outcome: usableForVerification ? "success" : "failure",
      attempt,
      bid: rate.bid,
      ask: rate.ask,
      spread: rate.ask - rate.bid,
      quoteDate: rate.date,
      probeReceivedAt,
      ageSeconds,
      freshnessThresholdMs: QUOTE_STALENESS_THRESHOLD_MS,
      freshness,
      usableForVerification,
      ...(usableForVerification ? {} : { reason: `freshness-${freshness.toLowerCase()}` }),
    });
    return {
      kind: "success",
      retrievalSucceeded: true,
      bid: rate.bid,
      ask: rate.ask,
      spread: rate.ask - rate.bid,
      date: rate.date,
      probeReceivedAt,
      ageSeconds,
      freshness,
      usableForVerification,
    };
  } catch (error) {
    if (error instanceof EtoroRateUnavailableError) {
      await recordStageResult(deps, instrument, "quote", { outcome: "failure", attempt, reason: error.reason });
      return { kind: "unavailable", reason: error.reason };
    }
    const message = toErrorMessage(error);
    await recordStageResult(deps, instrument, "quote", { outcome: "failure", attempt, reason: "transport-error", message });
    if (attempt === 1) {
      await sleep(INTER_INSTRUMENT_PAUSE_MS);
      return probeQuote(deps, instrument, 2);
    }
    return { kind: "transport-error", message: redactSecrets(message, deps.secrets) };
  }
}

/**
 * Stage 3 — historical candles and validation. Calls EtoroDemoBroker.getHistoricalCandles
 * (existing code, unmodified) — the plan's own explicitly-flagged "previously-unconfirmed" code
 * path, never verified live for any instrument before this tool exists. On a successful fetch, the
 * SAME validateHistoricalCandles (candle-validation.ts) the live trading runtime applies is run
 * unmodified — no interpolation or repair ever happens here — so "candles came back" is never
 * conflated with "candles are actually usable": a genuine gap/duplicate/malformed-OHLC/staleness
 * failure is recorded as "invalid", not "success". Both the requested and received candle counts are
 * always preserved, and a successful fetch's own freshness (`lastCandleAgeSeconds`) is always
 * explicit, never left for a reader to compute by hand from raw timestamps.
 */
async function probeCandles(deps: ProbeDeps, instrument: string, attempt = 1): Promise<CandleOutcome> {
  try {
    const candles = await deps.broker.getHistoricalCandles(instrument, deps.timeframe, deps.candleCount);
    try {
      validateHistoricalCandles(candles, instrument, { timeframe: deps.timeframe, maxCandleAgeSeconds: deps.maxCandleAgeSeconds });
    } catch (validationError) {
      const diagnostics = diagnoseCandleGaps(candles, instrument, deps.timeframe);
      const message = toErrorMessage(validationError);
      await recordStageResult(deps, instrument, "candles", {
        outcome: "failure",
        attempt,
        reason: "invalid",
        message,
        requestedCandleCount: deps.candleCount,
        rawCandleCount: diagnostics.rawCandleCount,
        firstTimestamp: diagnostics.firstTimestamp,
        lastTimestamp: diagnostics.lastTimestamp,
        duplicateTimestamps: diagnostics.duplicateTimestamps,
        detectedGaps: diagnostics.gaps,
      });
      return { kind: "invalid", message, gapCount: diagnostics.gaps.length };
    }
    const first = candles[0]!;
    const last = candles[candles.length - 1]!;
    const lastCandleAgeSeconds = Math.max(0, (Date.now() - Date.parse(last.timestamp)) / 1000);
    await recordStageResult(deps, instrument, "candles", {
      outcome: "success",
      attempt,
      requestedCandleCount: deps.candleCount,
      candleCount: candles.length,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
      lastCandleAgeSeconds,
    });
    return { kind: "success", candleCount: candles.length, firstTimestamp: first.timestamp, lastTimestamp: last.timestamp, lastCandleAgeSeconds };
  } catch (error) {
    if (error instanceof EtoroCandleHistoryUnavailableError) {
      await recordStageResult(deps, instrument, "candles", { outcome: "failure", attempt, reason: error.reason });
      return { kind: "unavailable", reason: error.reason };
    }
    const message = toErrorMessage(error);
    await recordStageResult(deps, instrument, "candles", { outcome: "failure", attempt, reason: "transport-error", message });
    if (attempt === 1) {
      await sleep(INTER_INSTRUMENT_PAUSE_MS);
      return probeCandles(deps, instrument, 2);
    }
    return { kind: "transport-error", message: redactSecrets(message, deps.secrets) };
  }
}

/**
 * Classifies one instrument's overall Phase 0 status per plan §6. NOT_TESTED is reserved for a
 * resolution attempt that never genuinely completed (a transport/auth/timeout error surviving the
 * retry) — this is deliberately never conflated with UNSUPPORTED, which means a genuine, conclusive
 * negative result. Quote and candles are gated only on resolution succeeding, and are evaluated
 * independently of each other (a working quote feed and a working candle feed are two distinct
 * capabilities — one failing must never be recorded as if the other did too). READ_ONLY_VERIFIED
 * requires BOTH to have genuinely succeeded — a malformed quote, a quote whose `usableForVerification`
 * is false (stale, unparseable timestamp, or missing timestamp — see QuoteFreshness), or
 * invalid/gapped candle history (all distinct from "success") always falls through to
 * PARTIALLY_SUPPORTED, never READ_ONLY_VERIFIED. VERIFIED itself is never assigned here at all —
 * see Classification's own doc comment.
 *
 * Live-BTC-run remediation (probe-etoro-1785446881512): `quote?.kind === "success"` ALONE used to
 * gate READ_ONLY_VERIFIED — a syntactically valid but 6045-second-stale quote passed that check,
 * since staleness was tracked in a separate, unconsulted field. The gate is now
 * `quote?.kind === "success" && quote.usableForVerification`, which is false for anything but a
 * fresh, parseable, within-threshold quote.
 */
export function classify(resolution: ResolutionOutcome, quote: QuoteOutcome | undefined, candles: CandleOutcome | undefined): Classification {
  if (resolution.kind === "transport-error") return "NOT_TESTED";
  if (resolution.kind === "no-match" || resolution.kind === "ambiguous") return "UNSUPPORTED";
  // resolution.kind === "success" from here.
  const quoteOk = quote?.kind === "success" && quote.usableForVerification;
  const candlesOk = candles?.kind === "success";
  if (quoteOk && candlesOk) return "READ_ONLY_VERIFIED";
  return "PARTIALLY_SUPPORTED";
}

/**
 * Explains WHY classify() returned what it did — empty exactly when READ_ONLY_VERIFIED (nothing to
 * explain), one or more machine-readable codes otherwise. Persisted into every evidence document's
 * own `classificationReasons` field (plan requirement 4) so a future catalogue-ingestion reader
 * never has to re-derive "why wasn't this READ_ONLY_VERIFIED" from raw stage outcomes by hand.
 */
export function classificationReasons(
  resolution: ResolutionOutcome,
  quote: QuoteOutcome | undefined,
  candles: CandleOutcome | undefined,
): string[] {
  if (resolution.kind === "transport-error") return ["RESOLUTION_TRANSPORT_ERROR"];
  if (resolution.kind === "no-match") return ["RESOLUTION_NO_MATCH"];
  if (resolution.kind === "ambiguous") return ["RESOLUTION_AMBIGUOUS"];

  const reasons: string[] = [];

  if (!quote) {
    reasons.push("QUOTE_NOT_ATTEMPTED");
  } else if (quote.kind === "malformed") {
    reasons.push("QUOTE_MALFORMED");
  } else if (quote.kind === "unavailable") {
    reasons.push("QUOTE_UNAVAILABLE");
  } else if (quote.kind === "transport-error") {
    reasons.push("QUOTE_TRANSPORT_ERROR");
  } else if (!quote.usableForVerification) {
    if (quote.freshness === "STALE") reasons.push("QUOTE_STALE");
    else if (quote.freshness === "INVALID_TIMESTAMP") reasons.push("QUOTE_TIMESTAMP_INVALID");
    else if (quote.freshness === "UNKNOWN") reasons.push("QUOTE_TIMESTAMP_MISSING");
  }

  if (!candles) {
    reasons.push("CANDLES_NOT_ATTEMPTED");
  } else if (candles.kind === "unavailable") {
    reasons.push("CANDLES_UNAVAILABLE");
  } else if (candles.kind === "invalid") {
    reasons.push("CANDLES_INVALID");
  } else if (candles.kind === "transport-error") {
    reasons.push("CANDLES_TRANSPORT_ERROR");
  }

  return reasons;
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

/** Writes one immutable evidence document for this run+instrument. Reuses JsonFileAuditTrail's own
 * atomic (temp-file + fsync + rename) write path rather than a second, parallel file-writing
 * implementation — `createFresh` because this file is never appended to again once written (unlike
 * PROBE_LOG_PATH). Returns the path so the caller can reference it from the concise cross-run event. */
async function writeInstrumentEvidence(doc: InstrumentEvidenceDocument, secrets: readonly string[]): Promise<string> {
  const fileName = `${doc.runId}__${doc.instrument}.json`;
  const filePath = path.join(EVIDENCE_DIR, fileName);
  const evidenceFile = await JsonFileAuditTrail.createFresh(filePath);
  // Final, generic safety net: every string field in the document, however produced, is redacted
  // once more here before it ever touches disk — see redactDeep's own doc comment.
  const sanitizedDoc = redactDeep(doc as unknown as Record<string, unknown>, secrets);
  await evidenceFile.record({
    timestamp: doc.completedAt,
    eventType: "INSTRUMENT_PROBE_CLASSIFIED",
    executionRunId: doc.runId,
    instrument: doc.instrument,
    details: sanitizedDoc,
  });
  return filePath;
}

/**
 * Quote-timestamp-semantics investigation (probe-etoro-1785448658984) — opt-in only
 * (`--diagnose-quote-fields`), never called during a default probe run. Issues its own, separate
 * eToro call (EtoroDemoBroker.getRateFieldDiagnostics) and records the curated field inspection;
 * never lets a diagnostic failure affect the instrument's own classification or abort the rest of
 * the probe.
 */
async function probeQuoteFieldDiagnostics(deps: ProbeDeps, instrument: string): Promise<RawRateFieldInspection | undefined> {
  try {
    const inspection = await deps.broker.getRateFieldDiagnostics(instrument);
    await recordStageResult(deps, instrument, "quote", {
      outcome: "diagnostic",
      diagnostic: "quote-field-inspection",
      selectedRowFound: inspection.selectedRowFound,
      availableFieldNames: inspection.availableFieldNames,
      timestampLikeFields: inspection.timestampLikeFields,
    });
    return inspection;
  } catch (error) {
    await recordStageResult(deps, instrument, "quote", {
      outcome: "diagnostic-failed",
      diagnostic: "quote-field-inspection",
      message: toErrorMessage(error),
    });
    return undefined;
  }
}

async function probeInstrument(
  deps: ProbeDeps,
  instrument: string,
  configuration: ProbeConfiguration,
  gitCommit: string | undefined,
  appVersion: string,
): Promise<{ result: InstrumentProbeResult; evidenceFile: string }> {
  const startedAt = new Date().toISOString();
  const resolution = await probeResolution(deps, instrument);

  let quote: QuoteOutcome | undefined;
  let candles: CandleOutcome | undefined;
  let quoteFieldDiagnostics: RawRateFieldInspection | undefined;
  if (resolution.kind === "success") {
    quote = await probeQuote(deps, instrument);
    candles = await probeCandles(deps, instrument);
    if (deps.diagnoseQuoteFields) {
      quoteFieldDiagnostics = await probeQuoteFieldDiagnostics(deps, instrument);
    }
  }

  const classification = classify(resolution, quote, candles);
  const reasons = classificationReasons(resolution, quote, candles);
  const completedAt = new Date().toISOString();

  const evidenceFile = await writeInstrumentEvidence(
    {
      schemaVersion: EVIDENCE_SCHEMA_VERSION,
      runId: deps.executionRunId,
      instrument,
      startedAt,
      completedAt,
      gitCommit,
      appVersion,
      configuration,
      resolution,
      quote,
      candles,
      classification,
      classificationReasons: reasons,
      quoteFieldDiagnostics,
    },
    deps.secrets,
  );

  // Concise, cross-run pointer event — the full detail lives in the evidence document above; this
  // is deliberately lightweight (never duplicates every stage's own detail a second time).
  // classificationReasons IS still duplicated here (unlike per-stage detail) since it's exactly
  // the field that makes a stale/malformed quote impossible to mistake for a clean pass even from
  // this lightweight log alone.
  await deps.auditTrail.record({
    timestamp: completedAt,
    eventType: "INSTRUMENT_PROBE_CLASSIFIED",
    executionRunId: deps.executionRunId,
    instrument,
    details: { classification, classificationReasons: reasons, evidenceFile },
  });

  return {
    result: { instrument, resolution, quote, candles, classification, classificationReasons: reasons, quoteFieldDiagnostics },
    evidenceFile,
  };
}

function describeResolution(outcome: ResolutionOutcome): string {
  switch (outcome.kind) {
    case "success":
      return `resolved -> instrumentId=${outcome.resolved.instrumentId}, instrumentTypeID=${outcome.resolved.instrumentTypeID ?? "unknown"}, exchangeID=${outcome.resolved.exchangeID ?? "unknown"}`;
    case "no-match":
      return "no match (UNSUPPORTED)";
    case "ambiguous":
      return `ambiguous, ${outcome.candidateCount} candidates (UNSUPPORTED — never auto-picked)`;
    case "transport-error":
      return `transport/auth error after retry: ${outcome.message} (NOT_TESTED)`;
  }
}

// Live-BTC-run remediation. A stale/unparseable/missing-timestamp quote must never print as a
// generic "success" line with a trailing "(STALE)" annotation easy to skim past — each non-fresh
// freshness state gets its own unmistakable, uppercase-led summary line instead, matching the
// terminal output the mission itself specifies (e.g. "STALE — age 6045s exceeds 60s threshold").
function describeQuote(outcome: QuoteOutcome | undefined): string {
  if (!outcome) return "not attempted (resolution did not succeed)";
  const thresholdSeconds = Math.round(QUOTE_STALENESS_THRESHOLD_MS / 1000);
  switch (outcome.kind) {
    case "success": {
      const base = `bid=${outcome.bid}, ask=${outcome.ask}, spread=${outcome.spread}, currency=unknown (never eToro-confirmed — see plan §4)`;
      const ageDisplay = outcome.ageSeconds !== undefined ? Math.round(outcome.ageSeconds) : undefined;
      switch (outcome.freshness) {
        case "FRESH":
          return `FRESH — age ${ageDisplay}s within ${thresholdSeconds}s threshold, quoteDate=${outcome.date} (${base}) — usable for verification`;
        case "STALE":
          return `STALE — age ${ageDisplay}s exceeds ${thresholdSeconds}s threshold (${base}) — NOT usable for verification`;
        case "INVALID_TIMESTAMP":
          return `INVALID TIMESTAMP — quote timestamp "${outcome.date}" could not be parsed (${base}) — NOT usable for verification`;
        case "UNKNOWN":
          return `UNKNOWN FRESHNESS — no quote timestamp returned (${base}) — NOT usable for verification (a missing timestamp is never assumed fresh)`;
      }
      break;
    }
    case "malformed":
      return `rate returned but not usable (${outcome.reason}) — recorded as malformed, never as success`;
    case "unavailable":
      return `no usable rate (${outcome.reason}) — possibly market closed or pricing unavailable (unconfirmed inference; eToro exposes no market-status field)`;
    case "transport-error":
      return `transport/auth error after retry: ${outcome.message}`;
  }
  return "unknown quote outcome";
}

function describeCandles(outcome: CandleOutcome | undefined): string {
  if (!outcome) return "not attempted (resolution did not succeed)";
  switch (outcome.kind) {
    case "success":
      return `${outcome.candleCount} candles, ${outcome.firstTimestamp} -> ${outcome.lastTimestamp} (last candle ${Math.round(outcome.lastCandleAgeSeconds)}s old)`;
    case "unavailable":
      return `no candle block returned (${outcome.reason})`;
    case "invalid":
      return `candles returned but failed validation (${outcome.gapCount} gap(s) detected): ${outcome.message}`;
    case "transport-error":
      return `transport/auth error after retry: ${outcome.message}`;
  }
}

function printUsage(): void {
  console.log("Usage:");
  console.log("  npm run broker:etoro-probe -- BTC");
  console.log("  npm run broker:etoro-probe -- ETH SOL");
  console.log("  npm run broker:etoro-probe -- --all");
  console.log("  npm run broker:etoro-probe -- BTC --diagnose-quote-fields   (opt-in, one extra read-only call per instrument)");
  console.log("");
  console.log(
    "No default instrument is probed when no argument is given — this tool never silently probes " +
      "the whole configured universe. Pass one or more symbols, or --all to explicitly opt into " +
      "probing every instrument in config.hermesAgent.instrumentUniverse.",
  );
}

export async function main(): Promise<void> {
  console.log("eToro Instrument Capability Probe — Phase 0, Stages 1-3 (read-only)");
  console.log("=====================================================================");
  console.log("Never places, closes, or alters any broker order. See broker-etoro-smoke.ts for Stage 4.");

  const executionRunId = `probe-etoro-${Date.now()}`;
  console.log(`Execution run id: ${executionRunId}`);

  const rawArgs = process.argv.slice(2);
  const wantsAll = rawArgs.some((arg) => arg.trim().toLowerCase() === "--all");
  // Quote-timestamp-semantics investigation. Opt-in only, off by default: an ordinary probe run's
  // request count/behaviour is completely unchanged unless this flag is explicitly given.
  const wantsQuoteFieldDiagnostics = rawArgs.some((arg) => arg.trim().toLowerCase() === "--diagnose-quote-fields");
  const KNOWN_FLAGS = new Set(["--all", "--diagnose-quote-fields"]);
  const cliInstruments = rawArgs
    .filter((arg) => !KNOWN_FLAGS.has(arg.trim().toLowerCase()))
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);

  if (!wantsAll && cliInstruments.length === 0) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (wantsAll && cliInstruments.length > 0) {
    console.log(`Note: --all was given alongside explicit symbol(s) (${cliInstruments.join(", ")}) — probing the full configured universe; the explicit symbols are redundant with --all and are ignored.`);
  }

  const config = getHermesExecutionConfig();
  console.log("Broker provider: etoro-demo (fixed for this command — BROKER_PROVIDER is not consulted)");

  const demoConfigCheck = checkEtoroDemoConfig(config);
  if (!demoConfigCheck.ok) {
    console.error(demoConfigCheck.reason);
    process.exitCode = 1;
    return;
  }
  console.log("Configuration valid (demo-only, no live route reachable).");

  const instruments = wantsAll ? config.hermesAgent.instrumentUniverse : cliInstruments;
  if (instruments.length === 0) {
    console.error("--all was given, but config.hermesAgent.instrumentUniverse is empty — nothing to probe.");
    process.exitCode = 1;
    return;
  }

  // Append-only: never resets prior evidence, unlike broker-etoro-smoke.ts's own fresh-per-run log.
  const auditTrail = await JsonFileAuditTrail.loadExisting(PROBE_LOG_PATH);

  let broker: EtoroReadOnlyProbeBroker;
  try {
    // Narrowed to the read-only interface the instant it's connected — every line below this point
    // is type-checked against resolveInstrument/getRate/getHistoricalCandles only.
    broker = await connectEtoroDemoBroker(config, auditTrail, executionRunId);
    console.log("Connected to eToro (credentials verified via demo portfolio read).");
  } catch (error) {
    console.error("Failed to connect to eToro Demo:", toErrorMessage(error));
    process.exitCode = 1;
    return;
  }

  console.log(`Probing ${instruments.length} instrument(s), sequentially: ${instruments.join(", ")}`);
  console.log(`Evidence: one JSON document per instrument under ${EVIDENCE_DIR}`);
  console.log(`Cross-run pointer log: ${PROBE_LOG_PATH} (append-only across every run)`);
  console.log("");

  const gitCommit = tryGetGitCommit();
  const appVersion = await tryGetAppVersion();
  const configuration: ProbeConfiguration = {
    brokerProvider: "etoro-demo",
    timeframe: config.marketData.timeframe,
    requestedCandleCount: config.marketData.candleCount,
    maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
    quoteStalenessThresholdMs: QUOTE_STALENESS_THRESHOLD_MS,
    currency: null,
  };

  if (wantsQuoteFieldDiagnostics) {
    console.log(
      "--diagnose-quote-fields enabled: one EXTRA read-only rates call per instrument will inspect " +
        "the raw response's own field names (quote-timestamp-semantics investigation).",
    );
  }

  const deps: ProbeDeps = {
    broker,
    auditTrail,
    executionRunId,
    timeframe: config.marketData.timeframe,
    candleCount: config.marketData.candleCount,
    maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
    secrets: [config.etoro.apiKey, config.etoro.userKey].filter((s): s is string => typeof s === "string" && s.length > 0),
    diagnoseQuoteFields: wantsQuoteFieldDiagnostics,
  };

  const results: InstrumentProbeResult[] = [];
  for (let i = 0; i < instruments.length; i++) {
    const instrument = instruments[i]!;
    console.log(`--- ${instrument} ---`);
    const { result, evidenceFile } = await probeInstrument(deps, instrument, configuration, gitCommit, appVersion);
    console.log(`  Stage 1 (resolution): ${describeResolution(result.resolution)}`);
    console.log(`  Stage 2 (quote):      ${describeQuote(result.quote)}`);
    console.log(`  Stage 3 (candles):    ${describeCandles(result.candles)}`);
    console.log(
      `  Classification:       ${result.classification}` +
        (result.classificationReasons.length > 0 ? ` (${result.classificationReasons.join(", ")})` : ""),
    );
    if (result.quoteFieldDiagnostics) {
      const d = result.quoteFieldDiagnostics;
      console.log(
        `  Quote field diagnostics: rowFound=${d.selectedRowFound}, fields=[${d.availableFieldNames.join(", ")}], ` +
          `timestampLikeFields=${JSON.stringify(d.timestampLikeFields)}`,
      );
    }
    console.log(`  Evidence:             ${evidenceFile}`);
    console.log("");
    results.push(result);

    if (i < instruments.length - 1) {
      await sleep(INTER_INSTRUMENT_PAUSE_MS);
    }
  }

  console.log("=== Summary ===");
  for (const result of results) {
    console.log(`  ${result.instrument.padEnd(8)} ${result.classification}`);
  }

  const unsupportedOrUntested = results.filter((r) => r.classification === "UNSUPPORTED" || r.classification === "NOT_TESTED");
  if (unsupportedOrUntested.length > 0) {
    console.log("");
    console.log(
      `${unsupportedOrUntested.length} of ${results.length} instrument(s) are UNSUPPORTED or NOT_TESTED — see the evidence ` +
        `documents for detail. This is informational, not a tool failure: the probe still ran to completion.`,
    );
  }

  // Exit code reflects whether the probe itself ran to completion, never an individual
  // instrument's classification — UNSUPPORTED/NOT_TESTED/PARTIALLY_SUPPORTED are legitimate,
  // informative outcomes of a successful read-only probe run, not failures of this tool.
  process.exitCode = 0;
}

// Only auto-runs when this file is executed directly (`tsx etoro-instrument-probe.ts`), not when
// imported elsewhere (e.g. its own test file, which imports `main` and calls it explicitly).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("eToro instrument probe crashed:", toErrorMessage(error));
    process.exitCode = 1;
  });
}
