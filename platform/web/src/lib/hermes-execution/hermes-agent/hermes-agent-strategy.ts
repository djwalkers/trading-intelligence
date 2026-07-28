import type { MarketDecisionContext } from "../market-decision-engine";
import type { Decision, Strategy, StrategyConditionResult } from "../strategies/strategy";
import type { InternalStrategy } from "../types";
import type { ValidatedHermesProposal } from "./types";

// Prototype 1.0 — official Hermes Agent decision integration. Translates already-validated Hermes
// proposals (one Hermes call per universe scan — see runtime/universe-scanner.ts) into the exact
// same Decision contract every other Strategy produces. Deliberately holds NO risk logic, NO
// sizing logic, and never calls a broker or persists anything directly — it only ever reads
// `this.scanProposals` (set once per scan, before MarketDecisionEngine.evaluate() is called once
// per eligible instrument, exactly like every other strategy) and shapes a Decision from it.
//
// Stateful by design: `setScanProposals()` is called ONCE per universe scan (by the orchestrator,
// after the single Hermes CLI call for that scan), then `evaluate()` is called once per eligible
// instrument in that same scan — mirroring exactly how MarketDecisionEngine.evaluate() already
// gets called once per instrument today, just now reading a pre-fetched result instead of
// re-deriving one. An instrument with no selected proposal this scan (not returned by Hermes, or
// filtered out by ranking/selection) always resolves to HOLD — never a guess, never stale data
// from a previous scan (setScanProposals() replaces the whole map every time it's called).

export const HERMES_AGENT_STRATEGY_ID = "HERMES-AGENT";
export const HERMES_AGENT_STRATEGY_VERSION = 1;

/** Prototype 1.0 — official Hermes Agent decision integration. The InternalStrategy metadata this
 * strategy is selected by (see strategy-loader.ts's own selectStrategy — HERMES_APPROVED is
 * preferred over DEMO_ONLY by default, making this the Prototype 1.0 decision authority without
 * touching strategy-selection logic itself). The `.instrument`/`.entryRules`/`.exitRules`/
 * `.riskRules` fields are structurally required by InternalStrategy but are never read by the live
 * TradingRuntime pipeline (confirmed: only execution-runner.ts/signal-engine.ts/risk-engine.ts —
 * the older, separate worker pipeline — ever read them) — harmless placeholders here, not
 * meaningful configuration. */
export function getHermesAgentInternalStrategy(): InternalStrategy {
  return {
    strategyId: HERMES_AGENT_STRATEGY_ID,
    version: HERMES_AGENT_STRATEGY_VERSION,
    sourceType: "HERMES_APPROVED",
    enabled: true,
    instrument: "MULTI",
    timeframe: "1h",
    entryRules: [],
    exitRules: [],
    riskRules: { maxPositionValue: 0 },
  };
}

function explainNoProposal(context: MarketDecisionContext): string[] {
  if (context.positionOpen) {
    return [`Position already open on ${context.instrument}`, "No Hermes SELL proposal for this instrument this scan"];
  }
  return [`No Hermes BUY proposal for ${context.instrument} this scan`];
}

export class HermesAgentStrategy implements Strategy {
  readonly id = HERMES_AGENT_STRATEGY_ID;
  readonly version = HERMES_AGENT_STRATEGY_VERSION;

  private scanProposals: ReadonlyMap<string, ValidatedHermesProposal> = new Map();

  /** Called once per universe scan, before this strategy's evaluate() is called for any
   * instrument that scan — replaces the entire map (never merges), so an instrument that had a
   * proposal last scan but not this one correctly reverts to HOLD, never stale data. */
  setScanProposals(selected: readonly ValidatedHermesProposal[]): void {
    this.scanProposals = new Map(selected.map((p) => [p.instrument, p]));
  }

  private proposalFor(context: MarketDecisionContext): ValidatedHermesProposal | undefined {
    return this.scanProposals.get(context.instrument);
  }

  /** `reasoning` always includes Hermes's own reasoning verbatim, plus one informational line
   * noting the suggested stop-loss/take-profit percentages when present — visible for audit and
   * human review, but NEVER fed into the actual stop-loss/take-profit computation: that remains
   * entirely owned by the existing, unmodified, deterministic build-trade-candidate.ts
   * (ATR-based `computeTradeLevels`), exactly like it already is for DEMO-0001. Hermes's suggested
   * percentages never reach TradeCandidate.stopLoss/takeProfit by any path. */
  private reasoningWithSuggestedLevels(proposal: ValidatedHermesProposal): string[] {
    const lines = [...proposal.reasoning];
    if (proposal.suggestedStopLossPercent !== undefined || proposal.suggestedTakeProfitPercent !== undefined) {
      lines.push(
        `Hermes suggested (informational only, not applied): stop-loss ${proposal.suggestedStopLossPercent ?? "n/a"}%, ` +
          `take-profit ${proposal.suggestedTakeProfitPercent ?? "n/a"}%.`,
      );
    }
    return lines;
  }

  checkEntryConditions(context: MarketDecisionContext): StrategyConditionResult {
    const proposal = this.proposalFor(context);
    if (!proposal || proposal.action !== "BUY") {
      return { met: false, reasons: [`No selected Hermes BUY proposal for ${context.instrument} this scan.`] };
    }
    return { met: true, reasons: this.reasoningWithSuggestedLevels(proposal) };
  }

  checkExitConditions(context: MarketDecisionContext): StrategyConditionResult {
    const proposal = this.proposalFor(context);
    if (!proposal || proposal.action !== "SELL") {
      return { met: false, reasons: [`No selected Hermes SELL proposal for ${context.instrument} this scan.`] };
    }
    return { met: true, reasons: this.reasoningWithSuggestedLevels(proposal) };
  }

  /** No additional filters beyond entry/exit conditions — every safety constraint (universe
   * membership, action validity, confidence/stop-loss/take-profit bounds, duplicate suppression)
   * was already enforced by validate-hermes-response.ts before a proposal could ever reach
   * `scanProposals` — this is a genuine no-op, never a second, redundant gate. */
  applyFilters(_context: MarketDecisionContext): StrategyConditionResult {
    return { met: true, reasons: [] };
  }

  calculateEntryConfidence(context: MarketDecisionContext): number {
    return this.proposalFor(context)?.confidence ?? 0;
  }

  calculateExitConfidence(context: MarketDecisionContext): number {
    return this.proposalFor(context)?.confidence ?? 0;
  }

  explainHold(context: MarketDecisionContext): string[] {
    return explainNoProposal(context);
  }

  // Prototype 1.0 — official Hermes Agent decision integration. `async` to satisfy Strategy's
  // contract — nothing here is awaited; this is a pure, already-fetched-data lookup, never a
  // second Hermes call, never a broker call, never a direct write to any repository/store.
  async evaluate(context: MarketDecisionContext): Promise<Decision> {
    const { instrument, positionOpen } = context;
    const proposal = this.proposalFor(context);

    if (positionOpen) {
      const exit = this.checkExitConditions(context);
      if (exit.met && proposal) {
        return {
          action: "SELL",
          confidence: this.calculateExitConfidence(context),
          reasoning: [`Position already open on ${instrument}`, ...exit.reasons],
          entryCriteriaMet: false,
          exitCriteriaMet: true,
          validationNotes: [],
        };
      }
      return {
        action: "HOLD",
        confidence: 0.5,
        reasoning: this.explainHold(context),
        entryCriteriaMet: false,
        exitCriteriaMet: false,
        validationNotes: [],
      };
    }

    const entry = this.checkEntryConditions(context);
    if (entry.met && proposal) {
      return {
        action: "BUY",
        confidence: this.calculateEntryConfidence(context),
        reasoning: entry.reasons,
        entryCriteriaMet: true,
        exitCriteriaMet: false,
        validationNotes: [],
      };
    }

    return {
      action: "HOLD",
      confidence: 0.5,
      reasoning: this.explainHold(context),
      entryCriteriaMet: false,
      exitCriteriaMet: false,
      validationNotes: [],
    };
  }
}
