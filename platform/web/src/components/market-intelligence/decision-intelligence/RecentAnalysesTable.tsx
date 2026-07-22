import { Badge } from "@/components/ui/Badge";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";
import { formatDateTime } from "@/lib/utils/format";
import { decisionBadgeClasses, formatMaybeNumber } from "./decision-intelligence-format";

interface RecentAnalysesTableProps {
  runs: AnalysisRun[];
}

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Read-only — no row is
// clickable into anything that could place an order, close a position, or alter configuration.
export function RecentAnalysesTable({ runs }: RecentAnalysesTableProps) {
  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <h2 className="text-sm font-semibold text-ink-100">Recent analyses</h2>
        <span className="text-xs text-ink-500">{runs.length} shown</span>
      </div>

      {runs.length === 0 ? (
        <p className="px-5 py-6 text-sm text-ink-500">No analyses match the current filters.</p>
      ) : (
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-base-700 text-xs text-ink-500">
                <th className="px-5 py-2 font-medium">Time</th>
                <th className="px-3 py-2 font-medium">Instrument</th>
                <th className="px-3 py-2 font-medium">Strategy</th>
                <th className="px-3 py-2 font-medium">Decision</th>
                <th className="px-3 py-2 font-medium">Confidence</th>
                <th className="px-3 py-2 font-medium">Trend</th>
                <th className="px-3 py-2 font-medium">RSI14</th>
                <th className="px-3 py-2 font-medium">Executed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-700/60">
              {runs.map((run) => (
                <tr key={run.id} data-testid="analysis-row">
                  <td className="whitespace-nowrap px-5 py-2.5 text-ink-300">{formatDateTime(run.createdAt)}</td>
                  <td className="px-3 py-2.5 text-ink-200">{run.instrument}</td>
                  <td className="px-3 py-2.5 text-ink-400">{run.strategyId}</td>
                  <td className="px-3 py-2.5">
                    <Badge className={decisionBadgeClasses(run.decision)}>{run.decision}</Badge>
                  </td>
                  <td className="px-3 py-2.5 text-ink-400">{formatMaybeNumber(run.confidence)}</td>
                  <td className="px-3 py-2.5 text-ink-400">{run.trend ?? "—"}</td>
                  <td className="px-3 py-2.5 text-ink-400">{formatMaybeNumber(run.rsi14, 1)}</td>
                  <td className="px-3 py-2.5">
                    {run.executedTrade ? (
                      <span className="text-accent-teal">Yes</span>
                    ) : (
                      <span className="text-ink-600">No</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
