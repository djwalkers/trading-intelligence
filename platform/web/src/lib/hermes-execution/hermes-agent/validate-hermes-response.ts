import type { MarketDecisionAction } from "../market-decision-engine";
import {
  HERMES_ALLOWED_ACTIONS,
  HERMES_VALIDATION_LIMITS,
  type HermesRawProposal,
  type HermesRawResponse,
  type HermesUniverseDecisionResult,
  type ValidatedHermesProposal,
} from "./types";

// Prototype 1.0 — official Hermes Agent decision integration. Pure, side-effect-free validation —
// no I/O, no subprocess, no clock. Given raw stdout text from a `hermes -z` call, this is the ONLY
// place Hermes's own output is ever trusted to shape a Decision — every rule the mission requires
// ("reject malformed output," "reject unknown instruments," ...) is enforced here, and nowhere
// else. A malformed or out-of-bounds response never partially succeeds: any single violation fails
// the WHOLE response closed (an empty, no-op proposal list — never a partially-trusted one).

/** Finds the last balanced top-level JSON object or array substring in `text` — handles "prose
 * around JSON" (the mission's own required test case) by scanning for the LAST closing brace/
 * bracket whose matching opening one still parses as valid JSON, rather than assuming the JSON is
 * the entire string or that it starts at index 0. Returns undefined if nothing in `text` parses. */
export function extractJsonFromOutput(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;

  // Fast path: the whole trimmed string is itself valid JSON (the common, well-behaved case).
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through to the scanning path below
  }

  // Scan every plausible top-level JSON start ('{' or '['), and for each, try the substring
  // running to the end, then progressively shorter suffixes trimmed from the end — bounded by the
  // string length, never a pathological worst case for the input sizes this adapter ever handles
  // (bounded upstream by maxStdoutBytes).
  for (let start = 0; start < trimmed.length; start += 1) {
    const ch = trimmed[start];
    if (ch !== "{" && ch !== "[") continue;
    for (let end = trimmed.length; end > start; end -= 1) {
      const candidate = trimmed.slice(start, end);
      try {
        return JSON.parse(candidate);
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOneProposal(
  raw: unknown,
  index: number,
  configuredUniverse: readonly string[],
): { ok: true; proposal: ValidatedHermesProposal } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return { ok: false, reason: `proposals[${index}] is not an object.` };
  }
  const candidate = raw as HermesRawProposal;

  if (typeof candidate.instrument !== "string" || candidate.instrument.trim().length === 0) {
    return { ok: false, reason: `proposals[${index}].instrument must be a non-empty string.` };
  }
  const instrument = candidate.instrument.trim().toUpperCase();
  if (!configuredUniverse.includes(instrument)) {
    return { ok: false, reason: `proposals[${index}].instrument "${instrument}" is not in the configured universe.` };
  }

  if (typeof candidate.action !== "string" || !HERMES_ALLOWED_ACTIONS.includes(candidate.action as MarketDecisionAction)) {
    return { ok: false, reason: `proposals[${index}].action must be one of ${HERMES_ALLOWED_ACTIONS.join(", ")}.` };
  }
  const action = candidate.action as MarketDecisionAction;

  if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)) {
    return { ok: false, reason: `proposals[${index}].confidence must be a finite number.` };
  }
  if (candidate.confidence < HERMES_VALIDATION_LIMITS.minConfidence || candidate.confidence > HERMES_VALIDATION_LIMITS.maxConfidence) {
    return {
      ok: false,
      reason: `proposals[${index}].confidence (${candidate.confidence}) must be between ${HERMES_VALIDATION_LIMITS.minConfidence} and ${HERMES_VALIDATION_LIMITS.maxConfidence}.`,
    };
  }

  if (!Array.isArray(candidate.reasoning)) {
    return { ok: false, reason: `proposals[${index}].reasoning must be an array of strings.` };
  }
  if (candidate.reasoning.length > HERMES_VALIDATION_LIMITS.maxReasoningItems) {
    return {
      ok: false,
      reason: `proposals[${index}].reasoning has ${candidate.reasoning.length} items, exceeding the maximum of ${HERMES_VALIDATION_LIMITS.maxReasoningItems}.`,
    };
  }
  const reasoning: string[] = [];
  for (const [reasonIndex, item] of candidate.reasoning.entries()) {
    if (typeof item !== "string") {
      return { ok: false, reason: `proposals[${index}].reasoning[${reasonIndex}] must be a string.` };
    }
    if (item.length > HERMES_VALIDATION_LIMITS.maxReasoningItemLength) {
      return {
        ok: false,
        reason: `proposals[${index}].reasoning[${reasonIndex}] exceeds the maximum length of ${HERMES_VALIDATION_LIMITS.maxReasoningItemLength} characters.`,
      };
    }
    reasoning.push(item);
  }

  let suggestedStopLossPercent: number | undefined;
  if (candidate.suggestedStopLossPercent !== undefined) {
    if (typeof candidate.suggestedStopLossPercent !== "number" || !Number.isFinite(candidate.suggestedStopLossPercent)) {
      return { ok: false, reason: `proposals[${index}].suggestedStopLossPercent must be a finite number when present.` };
    }
    if (candidate.suggestedStopLossPercent <= 0 || candidate.suggestedStopLossPercent > HERMES_VALIDATION_LIMITS.maxStopLossPercent) {
      return {
        ok: false,
        reason: `proposals[${index}].suggestedStopLossPercent (${candidate.suggestedStopLossPercent}) must be > 0 and <= ${HERMES_VALIDATION_LIMITS.maxStopLossPercent}.`,
      };
    }
    suggestedStopLossPercent = candidate.suggestedStopLossPercent;
  }

  let suggestedTakeProfitPercent: number | undefined;
  if (candidate.suggestedTakeProfitPercent !== undefined) {
    if (typeof candidate.suggestedTakeProfitPercent !== "number" || !Number.isFinite(candidate.suggestedTakeProfitPercent)) {
      return { ok: false, reason: `proposals[${index}].suggestedTakeProfitPercent must be a finite number when present.` };
    }
    if (
      candidate.suggestedTakeProfitPercent <= 0 ||
      candidate.suggestedTakeProfitPercent > HERMES_VALIDATION_LIMITS.maxTakeProfitPercent
    ) {
      return {
        ok: false,
        reason: `proposals[${index}].suggestedTakeProfitPercent (${candidate.suggestedTakeProfitPercent}) must be > 0 and <= ${HERMES_VALIDATION_LIMITS.maxTakeProfitPercent}.`,
      };
    }
    suggestedTakeProfitPercent = candidate.suggestedTakeProfitPercent;
  }

  // Allow-list extraction only — deliberately does NOT spread `candidate` or `raw` anywhere.
  // Whatever else Hermes included (quantity, notional, leverage, broker, execution instructions)
  // is read here, matched against nothing, and discarded by construction: it was never assigned to
  // any field of ValidatedHermesProposal, so it cannot propagate downstream no matter what it is.
  return {
    ok: true,
    proposal: { instrument, action, confidence: candidate.confidence, reasoning, suggestedStopLossPercent, suggestedTakeProfitPercent },
  };
}

/**
 * Validates raw stdout text from one `hermes -z` universe-scan call against the strict contract —
 * extracts the JSON (tolerating surrounding prose), checks the top-level shape, then validates
 * every proposal individually. ANY violation — malformed JSON, a missing `proposals` array, one bad
 * proposal, a duplicate instrument — fails the ENTIRE response closed (`ok: false`), never
 * partially trusting the rest. This is deliberate: a response that is wrong in one place cannot be
 * trusted to be right in the others.
 */
export function validateHermesUniverseResponse(rawStdout: string, configuredUniverse: readonly string[]): HermesUniverseDecisionResult {
  const parsed = extractJsonFromOutput(rawStdout);
  if (parsed === undefined) {
    return { ok: false, stage: "validation", reason: "No valid JSON object could be extracted from the Hermes response.", rawStdout };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, stage: "validation", reason: "The extracted JSON is not an object.", rawStdout };
  }
  const response = parsed as HermesRawResponse;

  if (!Array.isArray(response.proposals)) {
    return { ok: false, stage: "validation", reason: "The response's \"proposals\" field must be an array.", rawStdout };
  }

  const proposals: ValidatedHermesProposal[] = [];
  const seenInstruments = new Set<string>();
  for (const [index, rawProposal] of response.proposals.entries()) {
    const result = validateOneProposal(rawProposal, index, configuredUniverse);
    if (!result.ok) {
      return { ok: false, stage: "validation", reason: result.reason, rawStdout };
    }
    if (seenInstruments.has(result.proposal.instrument)) {
      return {
        ok: false,
        stage: "validation",
        reason: `Duplicate proposal for instrument "${result.proposal.instrument}" — each instrument may appear at most once.`,
        rawStdout,
      };
    }
    seenInstruments.add(result.proposal.instrument);
    proposals.push(result.proposal);
  }

  return { ok: true, proposals, rawStdout };
}
