import type { TradeCandidate } from "@/lib/hermes-execution/trade-approval/types";
import { formatDateTime } from "@/lib/utils/format";

/**
 * "Open positions" here means: an EXECUTED BUY TradeCandidate for a strategy+instrument with no
 * later matching close recorded in trade_performance — an approximation, not a live broker read.
 * TradeLifecycleStore (which knows the true, live OPEN/CLOSED state) is in-memory, per-process, and
 * unreachable from this app (see docs/trade-performance-engine-phase-4.md's own limitations
 * section) — trade_candidates is the best durable, cross-process signal available.
 */
export function OpenPositionsTable({ candidates }: { candidates: TradeCandidate[] }) {
  if (candidates.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No open positions (approximated from executed BUY candidates with no recorded close).</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">
              Instrument
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Strategy
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Entry price
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Stop loss
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Take profit
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Opened
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {candidates.map((candidate) => (
            <tr key={candidate.id} className="text-ink-300">
              <td className="px-4 py-2 text-ink-100">{candidate.instrument}</td>
              <td className="px-4 py-2">
                {candidate.strategyId} v{candidate.strategyVersion}
              </td>
              <td className="px-4 py-2">{candidate.entryPrice.toFixed(2)}</td>
              <td className="px-4 py-2">{candidate.stopLoss.toFixed(2)}</td>
              <td className="px-4 py-2">{candidate.takeProfit.toFixed(2)}</td>
              <td className="px-4 py-2 text-ink-500">{candidate.executedAt ? formatDateTime(candidate.executedAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
