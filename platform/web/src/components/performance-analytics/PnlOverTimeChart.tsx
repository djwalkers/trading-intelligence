import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";

const WIDTH = 800;
const HEIGHT = 180;
const BASELINE_Y = HEIGHT / 2;

/** One bar per closed trade, in exit-time order — up from the baseline for a net-positive trade,
 * down for a net-negative one. Colour follows outcome (WIN=teal, LOSS=red, BREAKEVEN=neutral),
 * matching DecisionIntelligenceView's own established OutcomeBadge palette — never a rainbow, never
 * colour-by-rank. */
export function PnlOverTimeChart({ records }: { records: TradePerformanceRecord[] }) {
  if (records.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  const ordered = [...records].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
  const maxAbs = Math.max(...ordered.map((r) => Math.abs(r.netPnl)), 1);
  const slotWidth = WIDTH / ordered.length;
  const barWidth = Math.max(1, slotWidth * 0.7);
  const scaleY = (HEIGHT / 2 - 8) / maxAbs;

  return (
    <div className="px-4 py-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Net profit and loss per closed trade, in order">
        <line x1={0} y1={BASELINE_Y} x2={WIDTH} y2={BASELINE_Y} stroke="currentColor" className="text-base-700" strokeWidth={1} />
        {ordered.map((record, index) => {
          const x = index * slotWidth + (slotWidth - barWidth) / 2;
          const barHeight = Math.abs(record.netPnl) * scaleY;
          const y = record.netPnl >= 0 ? BASELINE_Y - barHeight : BASELINE_Y;
          const colorClass = record.winLoss === "WIN" ? "fill-accent-teal" : record.winLoss === "LOSS" ? "fill-accent-red" : "fill-ink-500";
          return (
            <rect key={record.id} x={x} y={y} width={barWidth} height={Math.max(1, barHeight)} className={colorClass} rx={1}>
              <title>
                {record.instrument} — {record.netPnl >= 0 ? "+" : ""}
                {record.netPnl.toFixed(2)} ({record.winLoss}), closed {record.exitTime}
              </title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-2 flex items-center gap-4 text-xs text-ink-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-accent-teal" /> Win
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-accent-red" /> Loss
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-ink-500" /> Breakeven
        </span>
      </div>
    </div>
  );
}
