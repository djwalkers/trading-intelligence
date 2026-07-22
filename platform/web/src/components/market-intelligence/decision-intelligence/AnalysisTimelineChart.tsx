"use client";

import { useRef, useState, type MouseEvent } from "react";
import type { AnalysisRun } from "@/lib/hermes-execution/analysis/types";
import { formatDateTime } from "@/lib/utils/format";
import { decisionDotColor } from "./decision-intelligence-format";
import { fractionToX, timeToFraction } from "./timeline-geometry";

interface AnalysisTimelineChartProps {
  runs: AnalysisRun[];
}

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 160;
const LANES: { decision: AnalysisRun["decision"]; label: string; y: number }[] = [
  { decision: "BUY", label: "BUY", y: 30 },
  { decision: "HOLD", label: "HOLD", y: 70 },
  { decision: "SELL", label: "SELL", y: 110 },
  { decision: "ERROR", label: "ERROR", y: 150 },
];

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. A swimlane timeline — one row
// per decision type, one dot per analysis run, positioned left-to-right by actual timestamp (not
// index, since runs are not guaranteed evenly spaced). Same hand-rolled SVG approach as the
// diagnostics page's charts (no chart library in this repo — see chart-geometry.ts's own note).
export function AnalysisTimelineChart({ runs }: AnalysisTimelineChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverRun, setHoverRun] = useState<AnalysisRun | null>(null);

  if (runs.length === 0) {
    return <div className="panel p-6 text-sm text-ink-500">No analysis history yet for the current filters.</div>;
  }

  const times = runs.map((r) => Date.parse(r.createdAt));
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times);
  const laneByDecision = new Map(LANES.map((lane) => [lane.decision, lane.y]));

  function handleMouseMove(event: MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const fraction = (event.clientX - rect.left) / rect.width;
    const targetTime = minTime + fraction * (maxTime - minTime);
    let closest = runs[0]!;
    let closestDiff = Infinity;
    for (const run of runs) {
      const diff = Math.abs(Date.parse(run.createdAt) - targetTime);
      if (diff < closestDiff) {
        closestDiff = diff;
        closest = run;
      }
    }
    setHoverRun(closest);
  }

  return (
    <div className="panel flex flex-col gap-3 p-5">
      <div>
        <h2 className="text-sm font-semibold text-ink-100">Analysis timeline</h2>
        <p className="mt-0.5 text-xs text-ink-500">
          {runs.length} analysis run{runs.length === 1 ? "" : "s"} — {formatDateTime(runs[runs.length - 1]!.createdAt)} to{" "}
          {formatDateTime(runs[0]!.createdAt)}
        </p>
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="h-auto w-full"
          role="img"
          aria-label={`Analysis timeline, ${runs.length} runs`}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverRun(null)}
        >
          {LANES.map((lane) => (
            <g key={lane.decision}>
              <line x1={0} x2={CHART_WIDTH} y1={lane.y} y2={lane.y} stroke="#1c2230" strokeWidth={1} />
              <text x={4} y={lane.y - 8} fontSize={10} fill="#717d8f">
                {lane.label}
              </text>
            </g>
          ))}

          {runs.map((run) => {
            const x = fractionToX(timeToFraction(run.createdAt, minTime, maxTime), CHART_WIDTH);
            const y = laneByDecision.get(run.decision) ?? CHART_HEIGHT / 2;
            const isHovered = hoverRun?.id === run.id;
            return (
              <circle
                key={run.id}
                cx={x}
                cy={y}
                r={isHovered ? 5 : 3}
                fill={decisionDotColor(run.decision)}
                data-testid="timeline-dot"
              />
            );
          })}
        </svg>

        {hoverRun ? (
          <div
            className="pointer-events-none absolute top-2 right-2 rounded-lg border border-base-600 bg-base-900/95 px-3 py-2 text-xs text-ink-300 shadow-panel"
            data-testid="timeline-tooltip"
          >
            <p className="text-ink-100">{formatDateTime(hoverRun.createdAt)}</p>
            <p>
              {hoverRun.instrument} — {hoverRun.decision}
              {hoverRun.confidence !== undefined ? ` (${(hoverRun.confidence * 100).toFixed(0)}%)` : ""}
            </p>
            {hoverRun.executedTrade ? <p className="text-accent-teal">Trade executed</p> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
