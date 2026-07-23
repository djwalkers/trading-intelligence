import { buildLinePath, computePriceScale, priceToY } from "@/components/market-intelligence/diagnostics/chart-geometry";
import type { ResearchRunResult } from "@/lib/hermes-execution/research/types";

const WIDTH = 800;
const HEIGHT = 240;

/** Two lines, one colour each, plotted over TRADE SEQUENCE (not calendar time — the two strategies
 * take a different number of trades at different moments, so an index-aligned x-axis is the only
 * one that lets both curves render on the same chart without one collapsing to a single point). */
export function ComparisonEquityCurveChart({ a, b }: { a: ResearchRunResult; b: ResearchRunResult }) {
  if (a.equityCurve.length === 0 && b.equityCurve.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">Neither strategy took a trade in this window.</p>;
  }

  const aValues = a.equityCurve.map((p) => p.cumulativeNetPnl);
  const bValues = b.equityCurve.map((p) => p.cumulativeNetPnl);
  const scale = computePriceScale([...aValues, ...bValues, 0]);
  const maxCount = Math.max(aValues.length, bValues.length, 1);
  const pathA = buildLinePath(aValues, maxCount, WIDTH, HEIGHT, scale);
  const pathB = buildLinePath(bValues, maxCount, WIDTH, HEIGHT, scale);
  const zeroY = priceToY(0, scale, HEIGHT);

  return (
    <div className="px-4 py-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label={`Equity curves for ${a.strategyId} and ${b.strategyId}, by trade sequence`}>
        <line x1={0} y1={zeroY} x2={WIDTH} y2={zeroY} stroke="currentColor" className="text-base-700" strokeWidth={1} strokeDasharray="4 4" />
        {pathA ? <path d={pathA} fill="none" className="stroke-accent-teal" strokeWidth={2} /> : null}
        {pathB ? <path d={pathB} fill="none" className="stroke-accent-blue" strokeWidth={2} /> : null}
      </svg>
      <div className="mt-2 flex items-center gap-4 text-xs text-ink-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-4 rounded-full bg-accent-teal" /> {a.strategyId} ({aValues.length} trades)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-4 rounded-full bg-accent-blue" /> {b.strategyId} ({bValues.length} trades)
        </span>
        <span className="ml-auto text-ink-500">x-axis: trade sequence, not calendar time</span>
      </div>
    </div>
  );
}
