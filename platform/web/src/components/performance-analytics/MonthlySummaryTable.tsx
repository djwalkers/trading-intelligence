import type { MonthlySummary } from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";

export function MonthlySummaryTable({ months }: { months: MonthlySummary[] }) {
  if (months.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">
              Month
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Trades
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Wins
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Losses
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Win rate
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              Net P/L
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {[...months].reverse().map((month) => (
            <tr key={month.month} className="text-ink-300">
              <td className="px-4 py-2 text-ink-100">{month.month}</td>
              <td className="px-4 py-2">{month.tradeCount}</td>
              <td className="px-4 py-2 text-accent-teal">{month.winCount}</td>
              <td className="px-4 py-2 text-accent-red">{month.lossCount}</td>
              <td className="px-4 py-2">{(month.winRate * 100).toFixed(0)}%</td>
              <td className={`px-4 py-2 ${month.netPnl >= 0 ? "text-accent-teal" : "text-accent-red"}`}>
                {month.netPnl >= 0 ? "+" : ""}
                {month.netPnl.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
