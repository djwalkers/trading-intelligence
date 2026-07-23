import type { TradeDifferenceSummary } from "@/lib/hermes-execution/research/types";
import { formatDateTime } from "@/lib/utils/format";

export function TradeDifferencesTable({ summary, labelA, labelB }: { summary: TradeDifferenceSummary; labelA: string; labelB: string }) {
  const hasAny = summary.tradesOnlyInA.length > 0 || summary.tradesOnlyInB.length > 0 || summary.divergentTrades.length > 0;
  if (!hasAny) {
    return <p className="px-5 py-6 text-sm text-ink-500">No trade differences — both strategies took the same trades with the same outcomes.</p>;
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      {summary.tradesOnlyInA.length > 0 ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-200">Trades only {labelA} took ({summary.tradesOnlyInA.length})</h4>
          <ul className="space-y-0.5 text-xs text-ink-500">
            {summary.tradesOnlyInA.map((trade, index) => (
              <li key={index}>
                {formatDateTime(trade.entryTime)} → {formatDateTime(trade.exitTime)}: {trade.grossPnl >= 0 ? "+" : ""}
                {trade.grossPnl.toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.tradesOnlyInB.length > 0 ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-200">Trades only {labelB} took ({summary.tradesOnlyInB.length})</h4>
          <ul className="space-y-0.5 text-xs text-ink-500">
            {summary.tradesOnlyInB.map((trade, index) => (
              <li key={index}>
                {formatDateTime(trade.entryTime)} → {formatDateTime(trade.exitTime)}: {trade.grossPnl >= 0 ? "+" : ""}
                {trade.grossPnl.toFixed(2)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {summary.divergentTrades.length > 0 ? (
        <div>
          <h4 className="mb-1 text-xs font-semibold text-ink-200">Same entry, different outcome ({summary.divergentTrades.length})</h4>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-base-700/60 text-ink-500">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Entered
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {labelA}
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  {labelB}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-base-700/60">
              {summary.divergentTrades.map(({ a, b }, index) => (
                <tr key={index} className="text-ink-300">
                  <td className="py-1 pr-4 text-ink-500">{formatDateTime(a.entryTime)}</td>
                  <td className="py-1 pr-4">
                    {a.grossPnl >= 0 ? "+" : ""}
                    {a.grossPnl.toFixed(2)} (exit {formatDateTime(a.exitTime)})
                  </td>
                  <td className="py-1 pr-4">
                    {b.grossPnl >= 0 ? "+" : ""}
                    {b.grossPnl.toFixed(2)} (exit {formatDateTime(b.exitTime)})
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
