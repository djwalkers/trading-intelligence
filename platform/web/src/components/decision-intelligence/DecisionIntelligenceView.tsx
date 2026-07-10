"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { Badge } from "@/components/ui/Badge";
import { OutcomeSummaryPanel } from "@/components/decision-intelligence/OutcomeSummaryPanel";
import { useDecisionHistory } from "@/lib/state/decision-history-context";
import { useDecisionHistoryStatus } from "@/lib/state/use-decision-history-status";
import type { DecisionOutcome, DecisionRecord } from "@/lib/decision-intelligence";
import { formatCurrencyUSD, formatDateTime, formatPercent, formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

type ActionFilter = "All" | "Trade Opened" | "Rejected";
type ConfidenceBand = "All" | "90+" | "75-89" | "60-74" | "<60";
type OutcomeFilter = "All" | DecisionOutcome;

const ALL = "All";

// Minutes → a short, readable duration string (e.g. "45m", "3h 15m", "2d 4h") — holding durations
// here range from minutes (a fast reversal) to potentially days, so a single unit would either be
// unreadable at one extreme or misleadingly precise at the other.
function formatHoldingDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function matchesConfidenceBand(confidence: number, band: ConfidenceBand): boolean {
  switch (band) {
    case "All":
      return true;
    case "90+":
      return confidence >= 90;
    case "75-89":
      return confidence >= 75 && confidence < 90;
    case "60-74":
      return confidence >= 60 && confidence < 75;
    case "<60":
      return confidence < 60;
  }
}

function ActionBadge({ record }: { record: DecisionRecord }) {
  return (
    <Badge
      className={
        record.actionTaken === "Trade Opened"
          ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
          : "border-accent-red/30 bg-accent-red/10 text-accent-red"
      }
    >
      {record.actionTaken}
    </Badge>
  );
}

// Rejected decisions never have a trading outcome — there was no trade to win, lose, or break
// even on — so this deliberately never shows "Pending" for them (which would misleadingly imply an
// outcome is still coming). "N/A" is shown instead, visually distinct from every real outcome
// badge, satisfying the mission's "should not be incorrectly classified as trading wins or losses."
function OutcomeBadge({ record }: { record: DecisionRecord }) {
  if (record.actionTaken !== "Trade Opened") {
    return <span className="text-ink-600">N/A</span>;
  }

  const className =
    record.outcome === "Win"
      ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
      : record.outcome === "Loss"
        ? "border-accent-red/30 bg-accent-red/10 text-accent-red"
        : record.outcome === "Neutral"
          ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
          : "border-base-600 bg-base-800 text-ink-300";

  return <Badge className={className}>{record.outcome}</Badge>;
}

export function DecisionIntelligenceView() {
  const { records } = useDecisionHistory();
  const status = useDecisionHistoryStatus();

  const [strategyFilter, setStrategyFilter] = useState(ALL);
  const [agreementFilter, setAgreementFilter] = useState(ALL);
  const [symbolFilter, setSymbolFilter] = useState(ALL);
  const [actionFilter, setActionFilter] = useState<ActionFilter>("All");
  const [confidenceBand, setConfidenceBand] = useState<ConfidenceBand>("All");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("All");

  const strategies = useMemo(
    () => Array.from(new Set(records.map((record) => record.strategyUsed))).sort(),
    [records],
  );
  const agreements = useMemo(
    () => Array.from(new Set(records.map((record) => record.agreement))).sort(),
    [records],
  );
  const symbols = useMemo(
    () => Array.from(new Set(records.map((record) => record.symbol))).sort(),
    [records],
  );

  const filteredRecords = records.filter((record) => {
    if (strategyFilter !== ALL && record.strategyUsed !== strategyFilter) return false;
    if (agreementFilter !== ALL && record.agreement !== agreementFilter) return false;
    if (symbolFilter !== ALL && record.symbol !== symbolFilter) return false;
    if (actionFilter !== "All" && record.actionTaken !== actionFilter) return false;
    if (!matchesConfidenceBand(record.confidence, confidenceBand)) return false;
    // Outcome only ever describes an accepted decision — filtering by any outcome value
    // deliberately excludes Rejected rows, rather than lumping them in under "Pending" (they have
    // no trade to have an outcome at all).
    if (outcomeFilter !== "All") {
      if (record.actionTaken !== "Trade Opened") return false;
      if (record.outcome !== outcomeFilter) return false;
    }
    return true;
  });

  const acceptedCount = records.filter((record) => record.actionTaken === "Trade Opened").length;
  const rejectedCount = records.filter((record) => record.actionTaken === "Rejected").length;

  return (
    <>
      <PageHeader
        title="AI Decision History"
        description="Every candidate the AI Engine has ever evaluated — accepted and rejected alike — kept as a long-term record for future analysis."
      />

      <div className="panel flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-4 text-xs text-ink-500">
        <span>
          <span className="font-medium text-ink-200">{records.length}</span> record{records.length === 1 ? "" : "s"} stored
        </span>
        <span>
          <span className="font-medium text-accent-teal">{acceptedCount}</span> accepted
        </span>
        <span>
          <span className="font-medium text-accent-red">{rejectedCount}</span> rejected
        </span>
      </div>

      <SectionPanel
        title="Outcome summary"
        description="Accepted decisions only — paper-trading evidence, not a strategy performance claim"
      >
        <OutcomeSummaryPanel records={records} />
      </SectionPanel>

      <div className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Strategy
          <select
            value={strategyFilter}
            onChange={(event) => setStrategyFilter(event.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value={ALL}>All</option>
            {strategies.map((strategy) => (
              <option key={strategy} value={strategy}>
                {strategy}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          Agreement
          <select
            value={agreementFilter}
            onChange={(event) => setAgreementFilter(event.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value={ALL}>All</option>
            {agreements.map((agreement) => (
              <option key={agreement} value={agreement}>
                {agreement}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          Symbol
          <select
            value={symbolFilter}
            onChange={(event) => setSymbolFilter(event.target.value)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value={ALL}>All</option>
            {symbols.map((symbol) => (
              <option key={symbol} value={symbol}>
                {symbol}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          Action
          <select
            value={actionFilter}
            onChange={(event) => setActionFilter(event.target.value as ActionFilter)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value="All">All</option>
            <option value="Trade Opened">Trade Opened</option>
            <option value="Rejected">Rejected</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          Outcome
          <select
            value={outcomeFilter}
            onChange={(event) => setOutcomeFilter(event.target.value as OutcomeFilter)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value="All">All</option>
            <option value="Pending">Pending</option>
            <option value="Win">Win</option>
            <option value="Loss">Loss</option>
            <option value="Neutral">Neutral</option>
          </select>
        </label>

        <label className="flex items-center gap-2 text-xs text-ink-400">
          Confidence
          <select
            value={confidenceBand}
            onChange={(event) => setConfidenceBand(event.target.value as ConfidenceBand)}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            <option value="All">All</option>
            <option value="90+">90+</option>
            <option value="75-89">75–89</option>
            <option value="60-74">60–74</option>
            <option value="<60">Below 60</option>
          </select>
        </label>
      </div>

      <SectionPanel
        title="Decision history"
        description={
          filteredRecords.length === records.length
            ? `${records.length} decision record${records.length === 1 ? "" : "s"}`
            : `${filteredRecords.length} of ${records.length} records shown`
        }
      >
        {filteredRecords.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">
            {records.length === 0
              ? "No decision records yet. Run a Bot Scan from the Dashboard to start building history."
              : "No records match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-base-700/60 text-ink-500">
                  <th className="px-4 py-2 font-medium">Scan</th>
                  <th className="px-4 py-2 font-medium">Rank</th>
                  <th className="px-4 py-2 font-medium">Symbol</th>
                  <th className="px-4 py-2 font-medium">Sector</th>
                  <th className="px-4 py-2 font-medium">Side</th>
                  <th className="px-4 py-2 font-medium">Entry price</th>
                  <th className="px-4 py-2 font-medium">Strategy</th>
                  <th className="px-4 py-2 font-medium">Agreement</th>
                  <th className="px-4 py-2 font-medium">Confidence</th>
                  <th className="px-4 py-2 font-medium">Position action</th>
                  <th className="px-4 py-2 font-medium">Portfolio risk</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Reason</th>
                  <th className="px-4 py-2 font-medium">Outcome</th>
                  <th className="px-4 py-2 font-medium">Realised P/L</th>
                  <th className="px-4 py-2 font-medium">Realised P/L %</th>
                  <th className="px-4 py-2 font-medium">Holding duration</th>
                  <th className="px-4 py-2 font-medium">Recorded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-700/60">
                {filteredRecords.map((record) => (
                  <tr key={record.id} className="text-ink-300">
                    <td className="px-4 py-2 text-ink-500">{record.scanId}</td>
                    <td className="px-4 py-2">#{record.rank}</td>
                    <td className="px-4 py-2 text-ink-100">{record.symbol}</td>
                    <td className="px-4 py-2 text-ink-500">{record.sector}</td>
                    <td className="px-4 py-2">{record.side}</td>
                    <td className="px-4 py-2">
                      {record.entryPrice !== null ? formatCurrencyUSD(record.entryPrice) : "—"}
                    </td>
                    <td className="px-4 py-2">{record.strategyUsed}</td>
                    <td className="px-4 py-2">{record.agreement}</td>
                    <td className="px-4 py-2">{record.confidence}%</td>
                    <td className="px-4 py-2">{record.positionAction ?? "—"}</td>
                    <td className="px-4 py-2">{record.portfolioRiskResult}</td>
                    <td className="px-4 py-2">
                      <ActionBadge record={record} />
                    </td>
                    <td className="max-w-xs px-4 py-2 text-ink-500">
                      {record.rejectionReason ?? "—"}
                    </td>
                    <td className="px-4 py-2">
                      <OutcomeBadge record={record} />
                    </td>
                    <td className={`px-4 py-2 ${record.realisedPnl !== undefined ? plToneClass(record.realisedPnl) : "text-ink-600"}`}>
                      {record.realisedPnl !== undefined ? formatSignedNumber(record.realisedPnl) : "—"}
                    </td>
                    <td className={`px-4 py-2 ${record.realisedPnlPercent !== undefined ? plToneClass(record.realisedPnlPercent) : "text-ink-600"}`}>
                      {record.realisedPnlPercent !== undefined ? formatPercent(record.realisedPnlPercent) : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-500">
                      {record.holdingDurationMinutes !== undefined
                        ? formatHoldingDuration(record.holdingDurationMinutes)
                        : "—"}
                    </td>
                    <td className="px-4 py-2 text-ink-500">{formatDateTime(record.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <InfoNote>
        An accepted decision&apos;s outcome (Win/Loss/Neutral) is classified automatically once its
        linked paper trade closes — a Win/Loss threshold of just £0.01 either side of
        break-even, so a trade that closes essentially flat reads as Neutral rather than an
        arbitrary Win or Loss. Rejected candidates never have an outcome at all (shown as
        &quot;N/A&quot;, not &quot;Pending&quot;) — there was no trade to win or lose. History is
        stored using{" "}
        <strong className="font-medium text-ink-200">
          {status.mode === "Supabase" ? "your database" : "local browser storage"}
        </strong>
        . Rejected candidates are included deliberately, so future analysis can learn from ideas
        that didn&apos;t clear risk checks, not only from trades that were placed. Each record also
        captures the portfolio&apos;s deployed capital, available cash, and sector exposure at the
        moment of the decision — not shown as table columns here to keep this view simple, but
        present in every stored record for later analysis.
      </InfoNote>
    </>
  );
}
