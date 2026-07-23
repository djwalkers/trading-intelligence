import { buildLinePath, computePriceScale, priceToY } from "@/components/market-intelligence/diagnostics/chart-geometry";
import type { EquityCurvePoint } from "@/lib/hermes-execution/trade-performance/trade-performance-analytics";

const WIDTH = 800;
const HEIGHT = 220;

/** A single-hue line (accent-teal for net-positive territory, accent-red for net-negative — the
 * curve's OWN colour reflects its current sign, not a second series) over the cumulative net_pnl
 * series. Reuses the existing chart-geometry.ts helpers (Phase 2A.1) rather than a new SVG
 * library — one axis (net P/L), no dual-axis. */
export function EquityCurveChart({ points }: { points: EquityCurvePoint[] }) {
  if (points.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet — the equity curve will appear once one closes.</p>;
  }

  const values = points.map((p) => p.cumulativeNetPnl);
  const scale = computePriceScale([...values, 0]);
  const path = buildLinePath(values, points.length, WIDTH, HEIGHT, scale);
  const zeroY = priceToY(0, scale, HEIGHT);
  const latest = values[values.length - 1]!;
  const stroke = latest >= 0 ? "var(--accent-teal, #2dd4bf)" : "var(--accent-red, #f87171)";

  return (
    <div className="px-4 py-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Equity curve: cumulative net profit and loss over closed trades">
        <line x1={0} y1={zeroY} x2={WIDTH} y2={zeroY} stroke="currentColor" className="text-base-700" strokeWidth={1} strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={stroke} strokeWidth={2} />
      </svg>
      <div className="mt-2 flex justify-between text-xs text-ink-500">
        <span>{points[0]!.exitTime.slice(0, 10)}</span>
        <span className={latest >= 0 ? "text-accent-teal" : "text-accent-red"}>
          Cumulative: {latest >= 0 ? "+" : ""}
          {latest.toFixed(2)}
        </span>
        <span>{points[points.length - 1]!.exitTime.slice(0, 10)}</span>
      </div>
    </div>
  );
}
