"use client";

import { useRef, useState, type MouseEvent } from "react";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { formatDateTime } from "@/lib/utils/format";
import { buildLinePath, indexToX, nearestIndexForFraction, priceToY, type PriceScale } from "./chart-geometry";

interface RsiChartProps {
  data: MarketDiagnosticsResult;
}

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 140;
const RSI_COLOR = "#5b8def"; // accent-blue
const RSI_SCALE: PriceScale = { min: 0, max: 100 };
const REFERENCE_LEVELS = [30, 50, 70] as const;

// Phase 2A.1 — Internal Market Diagnostics UI, section E. RSI14 has a fixed, well-known 0-100
// range — unlike the candlestick chart, this never needs a data-driven scale. Reuses the exact
// same series (data.series.rsi14) the market-diagnostics-service.ts computed by calling
// calculateRsi (technical-indicators.ts) once per index — the formula itself is never touched or
// reimplemented here.
export function RsiChart({ data }: RsiChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const { series } = data;
  const count = series.rsi14.length;

  if (count === 0) {
    return null;
  }

  const path = buildLinePath(series.rsi14, count, CHART_WIDTH, CHART_HEIGHT, RSI_SCALE);

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    setHoverIndex(nearestIndexForFraction(fraction, count));
  }

  const hoverValue = hoverIndex !== null ? series.rsi14[hoverIndex] : undefined;
  const hoverTimestamp = hoverIndex !== null ? series.timestamps[hoverIndex] : undefined;

  return (
    <div className="panel flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">RSI14</h2>
        <p className="mt-0.5 text-xs text-ink-500">Reference levels at 30 (oversold), 50 (neutral), and 70 (overbought)</p>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`RSI14 chart for ${data.instrument}`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {REFERENCE_LEVELS.map((level) => (
            <g key={level}>
              <line
                x1={0}
                x2={CHART_WIDTH}
                y1={priceToY(level, RSI_SCALE, CHART_HEIGHT)}
                y2={priceToY(level, RSI_SCALE, CHART_HEIGHT)}
                stroke={level === 50 ? "#4d5666" : "#28303f"}
                strokeWidth={1}
                strokeDasharray={level === 50 ? undefined : "4,4"}
              />
              <text x={4} y={priceToY(level, RSI_SCALE, CHART_HEIGHT) - 4} fontSize={10} fill="#717d8f">
                {level}
              </text>
            </g>
          ))}

          <path d={path} fill="none" stroke={RSI_COLOR} strokeWidth={2} />

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

        {hoverValue !== undefined && hoverTimestamp ? (
          <div
            className="pointer-events-none absolute top-2 right-2 rounded-lg border border-base-600 bg-base-900/95 px-3 py-2 text-xs text-ink-300 shadow-panel"
            data-testid="rsi-tooltip"
          >
            <p className="text-ink-100">{formatDateTime(hoverTimestamp)}</p>
            <p style={{ color: RSI_COLOR }}>RSI14 {hoverValue.toFixed(1)}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
