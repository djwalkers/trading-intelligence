import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";

const SIZE = 160;
const RADIUS = 60;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const CENTER = SIZE / 2;

const SEGMENTS: { key: "WIN" | "LOSS" | "BREAKEVEN"; label: string; colorClass: string; strokeVar: string }[] = [
  { key: "WIN", label: "Win", colorClass: "text-accent-teal", strokeVar: "stroke-accent-teal" },
  { key: "LOSS", label: "Loss", colorClass: "text-accent-red", strokeVar: "stroke-accent-red" },
  { key: "BREAKEVEN", label: "Breakeven", colorClass: "text-ink-500", strokeVar: "stroke-ink-500" },
];

/** A donut, not a filled pie — matches this app's existing "thin marks" convention elsewhere
 * (chart-geometry.ts's own 2px lines). One segment per outcome, always the same fixed order/colour
 * (WIN/LOSS/BREAKEVEN), a legend beside it so identity is never colour-alone. */
export function WinLossPie({ records }: { records: TradePerformanceRecord[] }) {
  if (records.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  const counts = SEGMENTS.map((segment) => records.filter((r) => r.winLoss === segment.key).length);
  const total = records.length;

  const arcs = SEGMENTS.map((segment, index) => {
    const count = counts[index]!;
    const fraction = count / total;
    const dash = fraction * CIRCUMFERENCE;
    // Cumulative offset = the sum of every earlier segment's own dash length — computed
    // functionally (never a mutated outer variable) so this stays pure across re-renders.
    const offset = counts.slice(0, index).reduce((sum, c) => sum + (c / total) * CIRCUMFERENCE, 0);
    return { ...segment, count, fraction, dashArray: `${dash} ${CIRCUMFERENCE - dash}`, dashOffset: -offset };
  });

  return (
    <div className="flex items-center gap-6 px-4 py-3">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} role="img" aria-label="Win, loss, and breakeven proportions of closed trades">
        <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="none" strokeWidth={16} className="stroke-base-800" />
        {arcs
          .filter((arc) => arc.count > 0)
          .map((arc) => (
            <circle
              key={arc.key}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              strokeWidth={16}
              className={arc.strokeVar}
              strokeDasharray={arc.dashArray}
              strokeDashoffset={arc.dashOffset}
              transform={`rotate(-90 ${CENTER} ${CENTER})`}
            />
          ))}
      </svg>
      <ul className="flex flex-col gap-1.5 text-xs">
        {arcs.map((arc) => (
          <li key={arc.key} className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${arc.colorClass.replace("text-", "bg-")}`} />
            <span className="text-ink-300">{arc.label}</span>
            <span className="text-ink-500">
              {arc.count} ({(arc.fraction * 100).toFixed(0)}%)
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
