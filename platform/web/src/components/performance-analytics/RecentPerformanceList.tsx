import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";
import { Badge } from "@/components/ui/Badge";
import { formatRelativeTime } from "@/lib/utils/format";

const RECENT_COUNT = 10;

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

/** The most recent closed trades, newest first — a quick-glance feed distinct from the full,
 * sortable Closed Positions table below it. */
export function RecentPerformanceList({ records }: { records: TradePerformanceRecord[] }) {
  const recent = [...records].sort((a, b) => b.exitTime.localeCompare(a.exitTime)).slice(0, RECENT_COUNT);

  if (recent.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  return (
    <ul className="divide-y divide-base-700/60">
      {recent.map((record) => (
        <li key={record.id} className="flex items-center justify-between gap-4 px-4 py-2 text-xs">
          <span className="text-ink-100">{record.instrument}</span>
          <span className="text-ink-500">{record.strategyId}</span>
          <span className={record.netPnl >= 0 ? "text-accent-teal" : "text-accent-red"}>
            {record.netPnl >= 0 ? "+" : ""}
            {record.netPnl.toFixed(2)}
          </span>
          <Badge className={winLossBadgeClassName(record.winLoss)}>{record.winLoss}</Badge>
          <span className="text-ink-500">{formatRelativeTime(record.exitTime)}</span>
        </li>
      ))}
    </ul>
  );
}
