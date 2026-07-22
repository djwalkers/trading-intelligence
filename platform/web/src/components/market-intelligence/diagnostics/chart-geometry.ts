// Phase 2A.1 — Internal Market Diagnostics UI. Pure SVG geometry helpers, deliberately separate
// from any React/DOM rendering — this is the "chart data transformation" layer, directly
// unit-testable without mounting a component. No external chart library exists in this repo (see
// this phase's own research); a hand-rolled SVG chart avoids adding a new dependency for what is,
// geometrically, a simple linear index->x and price->y mapping.

export interface PriceScale {
  min: number;
  max: number;
}

/** A padded min/max over `values` — padding avoids a candle's wick or an EMA line touching the
 * very top/bottom edge of the chart. Degenerates gracefully: an empty array gets an arbitrary unit
 * scale (nothing will be plotted against it anyway); a perfectly flat series (min === max) still
 * gets a non-zero-height scale so priceToY never divides by zero. */
export function computePriceScale(values: number[]): PriceScale {
  if (values.length === 0) return { min: 0, max: 1 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { min: min - 1, max: max + 1 };
  const padding = (max - min) * 0.05;
  return { min: min - padding, max: max + padding };
}

/** Price -> SVG y-coordinate within a `chartHeight`-tall viewBox, y=0 at the top (SVG convention) —
 * higher prices produce smaller y values. */
export function priceToY(price: number, scale: PriceScale, chartHeight: number): number {
  const range = scale.max - scale.min;
  if (range === 0) return chartHeight / 2;
  return chartHeight - ((price - scale.min) / range) * chartHeight;
}

/** Candle index -> the horizontal center of that candle's slot within a `chartWidth`-wide viewBox,
 * `count` candles evenly spaced left to right (chronological, oldest first — matches this
 * pipeline's own Candle[] convention throughout). */
export function indexToX(index: number, count: number, chartWidth: number): number {
  if (count <= 1) return chartWidth / 2;
  const slot = chartWidth / count;
  return slot * index + slot / 2;
}

/** The full horizontal width allotted to one candle (body + wick + inter-candle gap). */
export function candleSlotWidth(count: number, chartWidth: number): number {
  if (count <= 0) return 0;
  return chartWidth / count;
}

/** An SVG path `d` string for a polyline through `values` (one point per index, aligned with
 * indexToX/candleSlotWidth's own `count`) — used for the EMA20/EMA50 overlay and the RSI14 line.
 * Returns an empty string for fewer than 2 points (nothing meaningful to draw a line through). */
export function buildLinePath(values: number[], count: number, chartWidth: number, chartHeight: number, scale: PriceScale): string {
  if (values.length < 2) return "";
  return values
    .map((value, index) => {
      const x = indexToX(index, count, chartWidth);
      const y = priceToY(value, scale, chartHeight);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

/** Maps a pointer's fractional horizontal position (0 = left edge, 1 = right edge) to the nearest
 * candle index — the hover/tooltip lookup, kept pure and independent of any real DOM event so it's
 * directly testable with plain numbers. Clamped to [0, count-1]. */
export function nearestIndexForFraction(fraction: number, count: number): number {
  if (count <= 0) return 0;
  const clamped = Math.min(1, Math.max(0, fraction));
  return Math.min(count - 1, Math.max(0, Math.round(clamped * (count - 1))));
}
