// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Pure time-axis geometry,
// separate from the diagnostics page's own chart-geometry.ts (that module maps an evenly-spaced
// candle *index* to x; this maps an actual *timestamp* to x, since analysis runs are not
// guaranteed evenly spaced — e.g. a paused runtime leaves a gap). Directly unit-testable.

/** `timestamp`'s fractional position between minTime and maxTime (both epoch ms), clamped to
 * [0, 1]. 0.5 when minTime === maxTime (a single point, or a zero-width range). */
export function timeToFraction(timestamp: string, minTime: number, maxTime: number): number {
  if (maxTime === minTime) return 0.5;
  const t = Date.parse(timestamp);
  const fraction = (t - minTime) / (maxTime - minTime);
  return Math.min(1, Math.max(0, fraction));
}

export function fractionToX(fraction: number, chartWidth: number): number {
  return fraction * chartWidth;
}
