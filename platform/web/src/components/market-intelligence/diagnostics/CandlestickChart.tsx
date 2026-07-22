"use client";

import { useRef, useState, type MouseEvent } from "react";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { formatDateTime } from "@/lib/utils/format";
import { buildLinePath, candleSlotWidth, computePriceScale, indexToX, nearestIndexForFraction, priceToY } from "./chart-geometry";
import { formatPrice } from "./diagnostics-format";

interface CandlestickChartProps {
  data: MarketDiagnosticsResult;
}

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 320;
const UP_COLOR = "#3ecf9e"; // accent-teal
const DOWN_COLOR = "#e2584f"; // accent-red
const EMA20_COLOR = "#5b8def"; // accent-blue
const EMA50_COLOR = "#e8a33d"; // accent-amber

// Phase 2A.1 — Internal Market Diagnostics UI, section C. A hand-rolled SVG candlestick chart —
// this repo has no existing chart library (see chart-geometry.ts's own note), and this task's own
// instructions say not to add a heavyweight one when none already exists. Geometry (index->x,
// price->y, the EMA polyline paths) lives in chart-geometry.ts as plain, testable functions; this
// file only renders SVG elements from their output plus a lightweight hover tooltip.
export function CandlestickChart({ data }: CandlestickChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { candles, series } = data;
  const count = candles.length;

  if (count === 0) {
    return <div className="panel p-6 text-sm text-ink-500">No candle history available to chart.</div>;
  }

  const allPrices = candles.flatMap((c) => [c.high, c.low]).concat(series.ema20, series.ema50);
  const scale = computePriceScale(allPrices);
  const slotWidth = candleSlotWidth(count, CHART_WIDTH);
  const bodyWidth = Math.max(1, slotWidth * 0.6);

  const ema20Path = buildLinePath(series.ema20, count, CHART_WIDTH, CHART_HEIGHT, scale);
  const ema50Path = buildLinePath(series.ema50, count, CHART_WIDTH, CHART_HEIGHT, scale);

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    setHoverIndex(nearestIndexForFraction(fraction, count));
  }

  const hoverCandle = hoverIndex !== null ? candles[hoverIndex] : undefined;
  const hoverEma20 = hoverIndex !== null ? series.ema20[hoverIndex] : undefined;
  const hoverEma50 = hoverIndex !== null ? series.ema50[hoverIndex] : undefined;

  return (
    <div className="panel flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">Candles ({data.timeframe})</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            Most recent {count} candles — {formatDateTime(data.candles[0]!.timestamp)} to{" "}
            {formatDateTime(data.candles[count - 1]!.timestamp)}
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs text-ink-400">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: EMA20_COLOR }} />
            EMA20
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 rounded-full" style={{ backgroundColor: EMA50_COLOR }} />
            EMA50
          </span>
        </div>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Candlestick chart for ${data.instrument}, ${count} candles`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* Recessive gridlines at 25/50/75% */}
          {[0.25, 0.5, 0.75].map((fraction) => (
            <line
              key={fraction}
              x1={0}
              x2={CHART_WIDTH}
              y1={CHART_HEIGHT * fraction}
              y2={CHART_HEIGHT * fraction}
              stroke="#1c2230"
              strokeWidth={1}
            />
          ))}

          {candles.map((candle, index) => {
            const x = indexToX(index, count, CHART_WIDTH);
            const up = candle.close >= candle.open;
            const color = up ? UP_COLOR : DOWN_COLOR;
            const bodyTop = priceToY(Math.max(candle.open, candle.close), scale, CHART_HEIGHT);
            const bodyBottom = priceToY(Math.min(candle.open, candle.close), scale, CHART_HEIGHT);
            const bodyHeight = Math.max(1, bodyBottom - bodyTop);

            return (
              <g key={candle.timestamp}>
                <line
                  x1={x}
                  x2={x}
                  y1={priceToY(candle.high, scale, CHART_HEIGHT)}
                  y2={priceToY(candle.low, scale, CHART_HEIGHT)}
                  stroke={color}
                  strokeWidth={1}
                />
                <rect x={x - bodyWidth / 2} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={color} />
              </g>
            );
          })}

          <path d={ema20Path} fill="none" stroke={EMA20_COLOR} strokeWidth={2} />
          <path d={ema50Path} fill="none" stroke={EMA50_COLOR} strokeWidth={2} />

          {hoverIndex !== null ? (
            <line
              x1={indexToX(hoverIndex, count, CHART_WIDTH)}
              x2={indexToX(hoverIndex, count, CHART_WIDTH)}
              y1={0}
              y2={CHART_HEIGHT}
              stroke="#4d5666"
              strokeWidth={1}
              strokeDasharray="3,3"
            />
          ) : null}
        </svg>

        {hoverCandle ? (
          <div
            className="pointer-events-none absolute top-2 right-2 rounded-lg border border-base-600 bg-base-900/95 px-3 py-2 text-xs text-ink-300 shadow-panel"
            data-testid="candlestick-tooltip"
          >
            <p className="text-ink-100">{formatDateTime(hoverCandle.timestamp)}</p>
            <p>
              O {formatPrice(hoverCandle.open)} H {formatPrice(hoverCandle.high)} L {formatPrice(hoverCandle.low)} C{" "}
              {formatPrice(hoverCandle.close)}
            </p>
            {hoverEma20 !== undefined ? <p style={{ color: EMA20_COLOR }}>EMA20 {formatPrice(hoverEma20)}</p> : null}
            {hoverEma50 !== undefined ? <p style={{ color: EMA50_COLOR }}>EMA50 {formatPrice(hoverEma50)}</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
