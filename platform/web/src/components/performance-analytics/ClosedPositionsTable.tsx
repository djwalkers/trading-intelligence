"use client";

import { Fragment, useState } from "react";
import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";
import type { TradeCandidate } from "@/lib/hermes-execution/trade-approval/types";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/utils/format";

function winLossBadgeClassName(winLoss: TradePerformanceRecord["winLoss"]): string {
  switch (winLoss) {
    case "WIN":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "LOSS":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
    case "BREAKEVEN":
      return "border-base-600 bg-base-800 text-ink-400";
  }
}

interface ChainDetailProps {
  record: TradePerformanceRecord;
  closingCandidate: TradeCandidate | undefined;
}

/**
 * The full chain for one closed trade, expanded inline: Analysis (analysis_run_id) -> Indicators
 * (EMA/RSI/ATR/trend, from the closing candidate's own frozen market context) -> Decision
 * (reasoning) -> Trade Candidate (id, entry/SL/TP) -> Approval (approvedBy/At) -> Execution
 * (brokerOrderId) -> Performance (this row's own metrics). Every step is already durably linked on
 * these two rows — this is a read-only, in-page view of that chain, not a new cross-page
 * navigation (see this dashboard's own doc comment on why: modifying the Trade Approval page's own
 * UI is out of this phase's scope).
 */
function ChainDetail({ record, closingCandidate }: ChainDetailProps) {
  const context = closingCandidate?.execution.marketContext;
  return (
    <div className="grid grid-cols-2 gap-x-8 gap-y-3 border-t border-base-700/60 bg-base-900/40 px-6 py-4 text-xs md:grid-cols-4">
      <div>
        <p className="font-medium text-ink-200">Analysis</p>
        <p className="mt-1 text-ink-500">{record.analysisRunId ?? "not recorded"}</p>
      </div>
      <div>
        <p className="font-medium text-ink-200">Indicators (at close)</p>
        {context ? (
          <p className="mt-1 text-ink-500">
            EMA20 {context.ema20.toFixed(2)} / EMA50 {context.ema50.toFixed(2)} · RSI14 {context.rsi14.toFixed(1)} · ATR14{" "}
            {context.atr14.toFixed(2)} · {context.trend}
          </p>
        ) : (
          <p className="mt-1 text-ink-500">closing candidate not resolvable</p>
        )}
      </div>
      <div>
        <p className="font-medium text-ink-200">Decision</p>
        <ul className="mt-1 list-inside list-disc text-ink-500">
          {(closingCandidate?.reasoning ?? []).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="font-medium text-ink-200">Trade candidate</p>
        <p className="mt-1 text-ink-500">
          {record.candidateId ?? "not recorded"}
          {closingCandidate ? ` · SL ${closingCandidate.stopLoss.toFixed(2)} / TP ${closingCandidate.takeProfit.toFixed(2)}` : ""}
        </p>
      </div>
      <div>
        <p className="font-medium text-ink-200">Approval</p>
        <p className="mt-1 text-ink-500">
          {closingCandidate?.approvedByUserId ? `${closingCandidate.approvedByUserId} at ${formatDateTime(closingCandidate.approvedAt!)}` : "not recorded"}
        </p>
      </div>
      <div>
        <p className="font-medium text-ink-200">Execution</p>
        <p className="mt-1 text-ink-500">{closingCandidate?.brokerOrderId ?? "not recorded"}</p>
      </div>
      <div>
        <p className="font-medium text-ink-200">Performance</p>
        <p className="mt-1 text-ink-500">
          R {record.riskMultiple !== undefined ? record.riskMultiple.toFixed(2) : "—"} · MFE {record.maxFavourableExcursion.toFixed(2)} ·
          MAE {record.maxAdverseExcursion.toFixed(2)} · drawdown {record.maximumDrawdown.toFixed(2)}
        </p>
      </div>
      <div>
        <p className="font-medium text-ink-200">Exit reason</p>
        <p className="mt-1 text-ink-500">{record.exitReason ?? "—"}</p>
      </div>
    </div>
  );
}

export function ClosedPositionsTable({
  records,
  candidatesById,
}: {
  records: TradePerformanceRecord[];
  candidatesById: Map<string, TradeCandidate>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (records.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin" role="region" aria-label="Closed positions table, click a row to see its full chain">
      <table className="w-full min-w-[1200px] text-left text-xs">
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">
              Instrument
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Strategy
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Entry / Exit
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Holding time
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Net P/L
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Return %
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              R
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Outcome
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Closed
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {records.map((record) => {
            const isExpanded = expandedId === record.id;
            return (
              <Fragment key={record.id}>
                <tr
                  className="cursor-pointer text-ink-300 hover:bg-base-800/40"
                  onClick={() => setExpandedId(isExpanded ? null : record.id)}
                  data-testid={`closed-position-row-${record.tradeId}`}
                >
                  <td className="px-4 py-2 text-ink-100">{record.instrument}</td>
                  <td className="px-4 py-2">
                    {record.strategyId} v{record.strategyVersion}
                  </td>
                  <td className="px-4 py-2">
                    {record.entryPrice.toFixed(2)} → {record.exitPrice.toFixed(2)}
                  </td>
                  <td className="px-4 py-2 text-ink-500">{(record.holdingTimeMs / 60_000).toFixed(0)}m</td>
                  <td className={`px-4 py-2 ${record.netPnl >= 0 ? "text-accent-teal" : "text-accent-red"}`}>
                    {record.netPnl >= 0 ? "+" : ""}
                    {record.netPnl.toFixed(2)}
                  </td>
                  <td className="px-4 py-2">{record.returnPercent.toFixed(2)}%</td>
                  <td className="px-4 py-2">{record.riskMultiple !== undefined ? record.riskMultiple.toFixed(2) : "—"}</td>
                  <td className="px-4 py-2">
                    <Badge className={winLossBadgeClassName(record.winLoss)}>{record.winLoss}</Badge>
                  </td>
                  <td className="px-4 py-2 text-ink-500">{formatDateTime(record.exitTime)}</td>
                </tr>
                {isExpanded ? (
                  <tr>
                    <td colSpan={9} className="p-0">
                      <ChainDetail record={record} closingCandidate={record.candidateId ? candidatesById.get(record.candidateId) : undefined} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
