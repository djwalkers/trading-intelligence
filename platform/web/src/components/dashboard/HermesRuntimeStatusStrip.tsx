import { Badge } from "@/components/ui/Badge";
import type { HermesSummaryData } from "@/lib/hermes-dashboard/types";
import { formatDateTime } from "@/lib/utils/format";

// Main Dashboard Hermes/eToro fix — requirement 8 (decision/runtime cards). GET /api/hermes/summary
// is the ONE authoritative source for the Hermes runtime's own state — never combined with, or
// substituted by, this browser's own local scan counters/localStorage decisions (see
// AIActivityKpis/RecentAIDecisionsList, both already clearly labelled "(this browser)" and
// deliberately left untouched — a genuinely separate, already-honestly-labelled local prototype
// source, per this requirement's own "unless clearly labelled" exception). Best-effort: `summary`
// is null whenever that fetch failed — this strip simply renders nothing rather than showing stale
// or fabricated runtime data.

interface HermesRuntimeStatusStripProps {
  summary: HermesSummaryData | null;
}

function healthBadgeClasses(status: string): string {
  if (status === "healthy") return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
  if (status === "degraded") return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
  if (status === "unavailable") return "border-accent-red/30 bg-accent-red/10 text-accent-red";
  return "border-base-600 bg-base-800 text-ink-400";
}

export function HermesRuntimeStatusStrip({ summary }: HermesRuntimeStatusStripProps) {
  if (!summary) {
    return (
      <p className="px-5 py-3 text-sm text-ink-500" data-testid="hermes-runtime-unavailable">
        Hermes runtime status is unavailable right now.
      </p>
    );
  }

  const runtimeState = summary.runtime?.state ?? "unknown";
  const isRuntimeDown = summary.health.status === "unavailable" || runtimeState === "STOPPED";

  return (
    <div className="flex flex-col gap-2 px-5 py-3 text-sm" data-testid="hermes-runtime-status">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={healthBadgeClasses(summary.health.status)}>{summary.health.status}</Badge>
        <span className="text-ink-300">Runtime: {runtimeState}</span>
        {isRuntimeDown ? (
          <Badge className="border-accent-red/30 bg-accent-red/10 text-accent-red" data-testid="hermes-runtime-unavailable-badge">
            Runtime unavailable
          </Badge>
        ) : null}
      </div>
      {summary.latestDecision ? (
        <span className="text-xs text-ink-500">
          Latest Hermes decision: {summary.latestDecision.symbol} {summary.latestDecision.outcome} at{" "}
          {formatDateTime(summary.latestDecision.timestamp)}
        </span>
      ) : (
        <span className="text-xs text-ink-500">No Hermes decision recorded yet.</span>
      )}
      {summary.recentFailure ? (
        <span className="text-xs text-accent-red">Recent failure: {summary.recentFailure.message}</span>
      ) : null}
    </div>
  );
}
