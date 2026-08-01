import type { InstrumentCatalogueEntry } from "../instrument-catalogue/instrument-catalogue";
import {
  validateStrategyDefinition,
  type IndicatorDefinition,
  type RuleNode,
  type StrategyDefinitionDocument,
  type ValidatedStrategyRecord,
} from "../strategy-definitions/strategy-definition";
import type { VariantParameterOverrides } from "./experiment-matrix";

// Phase 3 — Strategy Research Workflow. Generates IN-MEMORY strategy variants from a baseline
// document and re-validates every one through the REAL Phase 1 validator (`validateStrategyDefinition`
// — never a second, parallel/relaxed validator). No filesystem I/O anywhere in this module — a
// variant is never written to `strategies/`, never registered with any registry, and this module
// itself has no `fs` import at all, so it is structurally incapable of mutating the production
// strategy-definitions directory.
//
// Exactly which StrategyDefinitionDocument fields Phase 3 may vary (documented per-dimension below,
// per this phase's own explicit "document exactly which strategy fields may be varied" requirement):
//
//  - `emaFastPeriod` / `emaSlowPeriod`: the `parameters.period` of the two `type: "EMA"` indicators,
//    identified by their BASELINE (pre-override) period — the smaller is "fast," the larger is
//    "slow." Requires the baseline strategy to declare EXACTLY two EMA indicators; using either
//    dimension on a strategy with zero, one, or three+ EMA indicators is rejected outright, never
//    guessed.
//  - `rsiPeriod`: the `parameters.period` of the SINGLE `type: "RSI"` indicator. Requires exactly one.
//  - `rsiLowerBound` / `rsiUpperBound`: the `.value` of the `lowerBound`/`upperBound` CONSTANT
//    operands of the first `BETWEEN` rule node found (searching `entryRules` depth-first) whose own
//    `operand` is an `INDICATOR_ALIAS` referencing that same RSI indicator's `outputAlias`. Requires
//    exactly one such node.
//  - `atrPeriod`: the `parameters.period` of the SINGLE `type: "ATR"` indicator. Requires exactly one.
//  - `maxBarsHeld`: the `maxBars` of the SINGLE `signalExitRules` entry with `kind:
//    "MAX_BARS_HELD"`. Requires exactly one.
//  - `feeBps` / `slippageBps`: NEVER touch the strategy document at all — see
//    `splitCostOverrides` below. These become part of the research-run's own `BacktestRunConfig`,
//    exactly the same "cost is research/execution config, never strategy content" boundary Phase 2
//    itself already draws.
//
// Every other field of the document (strategyId, strategyVersion, status, supportedInstruments,
// timeframe, dataRequirements, entryRules' own logical structure and operators, eligibility,
// backtestPolicy, provenance, limitations) is COPIED VERBATIM from the baseline, byte-for-byte,
// never varied, never inferred.

export type StrategyOverrideRejectionReason =
  | "AMBIGUOUS_EMA_COUNT"
  | "AMBIGUOUS_RSI_COUNT"
  | "AMBIGUOUS_ATR_COUNT"
  | "AMBIGUOUS_MAX_BARS_HELD"
  | "RSI_BOUNDS_NODE_NOT_FOUND"
  | "INVALID_EMA_ORDERING"
  | "INVALID_RSI_BOUNDS_ORDERING"
  | "VALIDATION_FAILED";

export type StrategyOverrideResult = { ok: true; document: StrategyDefinitionDocument } | { ok: false; reason: StrategyOverrideRejectionReason; detail: string };

function cloneDocument(document: StrategyDefinitionDocument): StrategyDefinitionDocument {
  return JSON.parse(JSON.stringify(document)) as StrategyDefinitionDocument;
}

function findEmaIndicatorsSortedByBaselinePeriod(document: StrategyDefinitionDocument): IndicatorDefinition[] {
  return document.indicators.filter((i) => i.type === "EMA").sort((a, b) => a.parameters.period - b.parameters.period);
}

/** Depth-first search for the first `BETWEEN` node whose `operand` references `alias` — mirrors the
 * same recursive-rule-tree shape `evaluateRuleNode` (backtest/rule-evaluator.ts) already walks,
 * never a second, parallel tree-walking convention. */
function findBetweenNodeForAlias(node: RuleNode, alias: string): { operator: "BETWEEN"; operand: unknown; lowerBound: { kind: string; value?: number }; upperBound: { kind: string; value?: number } } | undefined {
  if (node.operator === "AND" || node.operator === "OR") {
    for (const child of node.rules) {
      const found = findBetweenNodeForAlias(child, alias);
      if (found) return found;
    }
    return undefined;
  }
  if (node.operator === "BETWEEN") {
    const operand = node.operand as { kind: string; alias?: string };
    if (operand.kind === "INDICATOR_ALIAS" && operand.alias === alias) {
      return node as unknown as { operator: "BETWEEN"; operand: unknown; lowerBound: { kind: string; value?: number }; upperBound: { kind: string; value?: number } };
    }
  }
  return undefined;
}

/**
 * Applies `overrides`' strategy-affecting fields (never `feeBps`/`slippageBps`, which this function
 * ignores entirely — see `splitCostOverrides`) to a CLONE of `baseline`, returning the resulting
 * document WITHOUT re-validating it (see `generateValidatedVariant` for the validated entry point
 * every caller outside this module should actually use). Rejects explicitly, never guesses, when a
 * requested dimension's target field can't be unambiguously located (see this module's own
 * top-of-file doc comment for exactly what "unambiguous" requires per dimension).
 */
export function applyStrategyOverrides(baseline: StrategyDefinitionDocument, overrides: VariantParameterOverrides): StrategyOverrideResult {
  const document = cloneDocument(baseline);

  if (overrides.emaFastPeriod !== undefined || overrides.emaSlowPeriod !== undefined) {
    const emaIndicators = findEmaIndicatorsSortedByBaselinePeriod(document);
    if (emaIndicators.length !== 2) {
      return { ok: false, reason: "AMBIGUOUS_EMA_COUNT", detail: `emaFastPeriod/emaSlowPeriod require exactly 2 EMA indicators on the baseline strategy; found ${emaIndicators.length}` };
    }
    const [fast, slow] = emaIndicators;
    if (overrides.emaFastPeriod !== undefined) fast!.parameters.period = overrides.emaFastPeriod;
    if (overrides.emaSlowPeriod !== undefined) slow!.parameters.period = overrides.emaSlowPeriod;
    // "Fast" and "slow" were assigned by BASELINE period order — overriding only one side (the
    // common case: a parameter sweep on just emaFastPeriod) can silently invert that ordering (e.g.
    // baseline fast=20/slow=50, override emaFastPeriod=60 alone) and produce a strategy whose trend
    // logic is reversed rather than merely re-parameterised. Rejected outright, never silently kept.
    if (fast!.parameters.period >= slow!.parameters.period) {
      return { ok: false, reason: "INVALID_EMA_ORDERING", detail: `after applying overrides, the "fast" EMA period (${fast!.parameters.period}) must be strictly less than the "slow" EMA period (${slow!.parameters.period})` };
    }
  }

  if (overrides.rsiPeriod !== undefined) {
    const rsiIndicators = document.indicators.filter((i) => i.type === "RSI");
    if (rsiIndicators.length !== 1) {
      return { ok: false, reason: "AMBIGUOUS_RSI_COUNT", detail: `rsiPeriod requires exactly 1 RSI indicator on the baseline strategy; found ${rsiIndicators.length}` };
    }
    rsiIndicators[0]!.parameters.period = overrides.rsiPeriod;
  }

  if (overrides.rsiLowerBound !== undefined || overrides.rsiUpperBound !== undefined) {
    const rsiIndicators = document.indicators.filter((i) => i.type === "RSI");
    if (rsiIndicators.length !== 1) {
      return { ok: false, reason: "AMBIGUOUS_RSI_COUNT", detail: `rsiLowerBound/rsiUpperBound require exactly 1 RSI indicator on the baseline strategy; found ${rsiIndicators.length}` };
    }
    const node = findBetweenNodeForAlias(document.entryRules, rsiIndicators[0]!.outputAlias);
    if (!node) {
      return { ok: false, reason: "RSI_BOUNDS_NODE_NOT_FOUND", detail: `no BETWEEN rule node found in entryRules referencing RSI indicator alias "${rsiIndicators[0]!.outputAlias}"` };
    }
    if (overrides.rsiLowerBound !== undefined && node.lowerBound.kind === "CONSTANT") node.lowerBound.value = overrides.rsiLowerBound;
    if (overrides.rsiUpperBound !== undefined && node.upperBound.kind === "CONSTANT") node.upperBound.value = overrides.rsiUpperBound;
    // Same single-sided-override risk as the EMA fast/slow check above: overriding only
    // rsiLowerBound (or only rsiUpperBound) could silently cross the two bounds.
    if (node.lowerBound.kind === "CONSTANT" && node.upperBound.kind === "CONSTANT" && node.lowerBound.value !== undefined && node.upperBound.value !== undefined && node.lowerBound.value >= node.upperBound.value) {
      return { ok: false, reason: "INVALID_RSI_BOUNDS_ORDERING", detail: `after applying overrides, rsiLowerBound (${node.lowerBound.value}) must be strictly less than rsiUpperBound (${node.upperBound.value})` };
    }
  }

  if (overrides.atrPeriod !== undefined) {
    const atrIndicators = document.indicators.filter((i) => i.type === "ATR");
    if (atrIndicators.length !== 1) {
      return { ok: false, reason: "AMBIGUOUS_ATR_COUNT", detail: `atrPeriod requires exactly 1 ATR indicator on the baseline strategy; found ${atrIndicators.length}` };
    }
    atrIndicators[0]!.parameters.period = overrides.atrPeriod;
  }

  if (overrides.maxBarsHeld !== undefined) {
    const maxBarsRules = document.signalExitRules.filter((r) => r.kind === "MAX_BARS_HELD");
    if (maxBarsRules.length !== 1) {
      return { ok: false, reason: "AMBIGUOUS_MAX_BARS_HELD", detail: `maxBarsHeld requires exactly 1 MAX_BARS_HELD signalExitRules entry on the baseline strategy; found ${maxBarsRules.length}` };
    }
    (maxBarsRules[0] as { kind: "MAX_BARS_HELD"; maxBars: number }).maxBars = overrides.maxBarsHeld;
  }

  return { ok: true, document };
}

/** `feeBps`/`slippageBps` are never applied to the strategy document (see this module's own
 * top-of-file doc comment) — this extracts just those two, for the caller to merge into the
 * research run's own `BacktestRunConfig` instead. */
export function splitCostOverrides(overrides: VariantParameterOverrides): { feeBps?: number; slippageBps?: number } {
  return { feeBps: overrides.feeBps, slippageBps: overrides.slippageBps };
}

export type VariantValidationResult = { ok: true; record: ValidatedStrategyRecord } | { ok: false; reason: StrategyOverrideRejectionReason; detail: string };

/**
 * The one entry point every caller outside this module should use: applies `overrides` to
 * `baseline`, then re-validates the RESULT through the exact same `validateStrategyDefinition`
 * Phase 1 itself uses — never a relaxed or research-specific validator. Additionally asserts every
 * one of this phase's own safety invariants that a structurally-valid-but-wrong mutation could
 * otherwise violate: `strategyId`/`strategyVersion`/`status`/`supportedInstruments` unchanged from
 * baseline, and `usableForDemo` still unconditionally `false` (Phase 1's own guarantee, reasserted
 * here defensively). `filePath` is set to a synthetic, unmistakable
 * `"<research-variant:{baseline strategyId}@{baseline strategyVersion}>"` marker — this document was
 * never read from, and is never written to, any file.
 */
export function generateValidatedVariant(baseline: StrategyDefinitionDocument, catalogueEntries: readonly InstrumentCatalogueEntry[], overrides: VariantParameterOverrides, loadedAt: string): VariantValidationResult {
  const applied = applyStrategyOverrides(baseline, overrides);
  if (!applied.ok) return applied;

  const syntheticPath = `<research-variant:${baseline.strategyId}@${baseline.strategyVersion}>`;
  const validation = validateStrategyDefinition(applied.document, syntheticPath, catalogueEntries, loadedAt);
  if (!validation.ok) {
    return { ok: false, reason: "VALIDATION_FAILED", detail: `${validation.reason}: ${validation.detail}` };
  }

  const { document } = validation.record;
  if (document.strategyId !== baseline.strategyId || document.strategyVersion !== baseline.strategyVersion || document.status !== baseline.status) {
    return { ok: false, reason: "VALIDATION_FAILED", detail: "internal invariant violated — a variant must never change strategyId/strategyVersion/status from the baseline" };
  }
  if (document.supportedInstruments.length !== baseline.supportedInstruments.length || !document.supportedInstruments.every((i) => baseline.supportedInstruments.includes(i))) {
    return { ok: false, reason: "VALIDATION_FAILED", detail: "internal invariant violated — a variant must never add or remove supportedInstruments" };
  }
  if (validation.record.result.usableForDemo !== false) {
    return { ok: false, reason: "VALIDATION_FAILED", detail: "internal invariant violated — usableForDemo must remain false for every research variant" };
  }

  return { ok: true, record: validation.record };
}
