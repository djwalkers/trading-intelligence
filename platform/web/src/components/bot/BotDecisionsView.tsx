"use client";

import { Badge } from "@/components/ui/Badge";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { formatCurrencyGBP, formatDateTime } from "@/lib/utils/format";
import type { BotRiskCheck } from "@/lib/bot";

const POSITION_ACTION_TONE: Record<string, string> = {
  NEW_POSITION: "text-accent-teal",
  ADD_TO_POSITION: "text-accent-teal",
  HOLD_POSITION: "text-accent-amber",
  BLOCK_POSITION: "text-accent-red",
};

function RiskCheckList({ checks }: { checks: BotRiskCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-col gap-0.5">
      {checks.map((check) => (
        <li key={check.name} className="flex items-start gap-2 text-xs">
          <span className={check.passed ? "text-accent-teal" : "text-accent-red"}>
            {check.passed ? "Passed" : "Failed"}
          </span>
          <span className="text-ink-500">
            {check.name} — {check.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function BotDecisionsView() {
  const { decisions } = useBotDecisionLog();

  if (decisions.length === 0) {
    return (
      <p className="px-5 py-6 text-sm text-ink-500">
        No bot scans yet. Run one from the &quot;Run Bot Scan&quot; button on the Dashboard.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-base-700/60">
      {decisions.map((decision) => {
        const rejectedCandidates = decision.candidates.filter(
          (candidate) => candidate.outcome === "Rejected",
        );
        const executedCandidate = decision.candidates.find(
          (candidate) => candidate.outcome === "Trade Opened",
        );
        const snapshot = decision.portfolioSnapshotBefore;

        return (
          <div key={decision.id} className="flex flex-col gap-3 px-5 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-0.5">
                <span className="text-sm font-medium text-ink-100">
                  {decision.scanId}{" "}
                  <span className="text-xs font-normal text-ink-500">· {decision.triggerType}</span>
                </span>
                <span className="text-xs text-ink-500">{formatDateTime(decision.timestamp)}</span>
              </div>
              <Badge
                className={
                  decision.tradeCreated
                    ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                    : "border-base-600 bg-base-800 text-ink-300"
                }
              >
                {decision.actionTaken}
              </Badge>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
              <span>Scanned: {decision.instrumentsScanned.join(", ")}</span>
              <span>Candidates evaluated: {decision.candidates.length}</span>
              <span>Rejected: {rejectedCandidates.length}</span>
              <span>Execution time: {decision.executionTimeMs.toFixed(1)}ms</span>
            </div>

            {decision.selectedInstrument ? (
              <p className="text-xs text-ink-400">
                Executed: <span className="text-ink-200">{decision.selectedInstrument}</span>
                {decision.selectedInstrumentName ? ` · ${decision.selectedInstrumentName}` : ""}
              </p>
            ) : null}

            <p className="text-sm text-ink-300">{decision.reason}</p>

            {snapshot ? (
              <details className="text-xs text-ink-500">
                <summary className="cursor-pointer select-none text-ink-400">
                  Portfolio exposure at scan time
                </summary>
                <div className="mt-1.5 flex flex-col gap-1 border-l border-base-700 pl-3">
                  <span>
                    {snapshot.totalOpenTrades} open trade(s) ·{" "}
                    {formatCurrencyGBP(snapshot.totalCapitalDeployed)} deployed ·{" "}
                    {formatCurrencyGBP(snapshot.availableCash)} available cash
                  </span>
                  <span>
                    By side: BUY {snapshot.countBySide.BUY} (
                    {formatCurrencyGBP(snapshot.capitalBySide.BUY)}) · SELL {snapshot.countBySide.SELL} (
                    {formatCurrencyGBP(snapshot.capitalBySide.SELL)})
                  </span>
                  {Object.keys(snapshot.countBySector).length > 0 ? (
                    <span>
                      By sector:{" "}
                      {Object.entries(snapshot.countBySector)
                        .map(
                          ([sector, count]) =>
                            `${sector} ${count} (${formatCurrencyGBP(snapshot.capitalBySector[sector] ?? 0)})`,
                        )
                        .join(", ")}
                    </span>
                  ) : null}
                </div>
              </details>
            ) : null}

            {decision.candidates.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-ink-400">Candidate evaluation</span>
                <ul className="flex flex-col gap-2">
                  {decision.candidates.map((candidate) => (
                    <li
                      key={candidate.instrumentSymbol}
                      className="rounded-lg border border-base-700 bg-base-850 px-3 py-2"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-ink-200">
                          #{candidate.rank} {candidate.instrumentSymbol} · {candidate.instrumentName}
                        </span>
                        <span
                          className={
                            candidate.outcome === "Trade Opened"
                              ? "text-xs text-accent-teal"
                              : "text-xs text-accent-red"
                          }
                        >
                          {candidate.outcome === "Trade Opened" ? "Executed" : "Rejected"}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-ink-500">
                        {candidate.side} · {candidate.confidence}% confidence · {candidate.agreement}
                      </p>
                      {candidate.rejectionReason ? (
                        <p className="mt-1 text-xs text-accent-red">{candidate.rejectionReason}</p>
                      ) : null}

                      <p className="mt-2 text-xs font-medium text-ink-400">
                        Individual risk checks —{" "}
                        <span className={candidate.individualPassed ? "text-accent-teal" : "text-accent-red"}>
                          {candidate.individualPassed ? "Passed" : "Failed"}
                        </span>
                      </p>
                      <RiskCheckList checks={candidate.individualRiskChecks} />

                      {candidate.positionEvaluated ? (
                        <>
                          <p className="mt-2 text-xs font-medium text-ink-400">
                            Position Manager —{" "}
                            <span className={POSITION_ACTION_TONE[candidate.positionAction ?? ""] ?? "text-ink-300"}>
                              {candidate.positionAction}
                            </span>
                          </p>
                          <p className="text-xs text-ink-500">
                            Existing position: {formatCurrencyGBP(candidate.existingPositionValue ?? 0)} · After
                            trade: {formatCurrencyGBP(candidate.positionValueAfterTrade ?? 0)}
                          </p>
                          {candidate.positionDecisionReason ? (
                            <p className="text-xs text-ink-500">{candidate.positionDecisionReason}</p>
                          ) : null}
                          <RiskCheckList checks={candidate.positionChecks} />
                        </>
                      ) : (
                        <p className="mt-2 text-xs text-ink-600">
                          Position Manager not evaluated — individual checks failed first.
                        </p>
                      )}

                      {candidate.portfolioRiskEvaluated ? (
                        <>
                          <p className="mt-2 text-xs font-medium text-ink-400">
                            Portfolio risk checks —{" "}
                            <span className={candidate.portfolioPassed ? "text-accent-teal" : "text-accent-red"}>
                              {candidate.portfolioPassed ? "Passed" : "Failed"}
                            </span>
                          </p>
                          <RiskCheckList checks={candidate.portfolioRiskChecks} />
                        </>
                      ) : (
                        <p className="mt-2 text-xs text-ink-600">
                          Portfolio risk not evaluated —{" "}
                          {!candidate.individualPassed
                            ? "individual checks failed first."
                            : "the Position Manager did not allow a new or added position."}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {decision.trace.length > 0 ? (
              <details className="text-xs text-ink-500">
                <summary className="cursor-pointer select-none text-ink-400">Full scan trace</summary>
                <ol className="mt-1.5 flex flex-col gap-1 border-l border-base-700 pl-3">
                  {decision.trace.map((step, index) => (
                    <li key={`${decision.id}-trace-${index}`}>
                      <span className="text-ink-300">{step.step}</span>
                      <span className="text-ink-500"> — {step.detail}</span>
                    </li>
                  ))}
                </ol>
              </details>
            ) : null}

            {executedCandidate ? (
              <p className="text-xs text-accent-teal">Trade created: {decision.createdTradeId}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
