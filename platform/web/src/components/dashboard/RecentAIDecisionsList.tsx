"use client";

import { Badge } from "@/components/ui/Badge";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { formatDateTime } from "@/lib/utils/format";

const RECENT_LIMIT = 5;

// Build 1.12.0 — a compact "what has the AI Engine decided lately" list for the Dashboard, reading
// the same local decision log the full Bot Decisions history page reads (this browser's manual
// and browser-scheduled scans only — see AIActivityKpis for the same disclosed scope).
export function RecentAIDecisionsList() {
  const { decisions } = useBotDecisionLog();
  const recent = decisions.slice(0, RECENT_LIMIT);

  if (recent.length === 0) {
    return (
      <p className="px-5 py-6 text-sm text-ink-500">
        No AI decisions recorded yet in this browser. Use &quot;Run scan now&quot; below, or turn on
        automatic scanning in Settings.
      </p>
    );
  }

  return (
    <div className="flex flex-col divide-y divide-base-700/60">
      {recent.map((decision) => (
        <div key={decision.id} className="flex items-center justify-between gap-4 px-5 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm text-ink-100">
              {decision.selectedInstrument ? (
                <>
                  {decision.selectedInstrument}
                  {decision.selectedInstrumentName ? ` · ${decision.selectedInstrumentName}` : ""}
                </>
              ) : (
                <span className="text-ink-400">{decision.reason}</span>
              )}
            </span>
            <span className="text-xs text-ink-500">
              {formatDateTime(decision.timestamp)} · {decision.triggerType} ·{" "}
              {decision.candidates.length} candidate{decision.candidates.length === 1 ? "" : "s"} evaluated
            </span>
          </div>
          <Badge
            className={
              decision.tradeCreated
                ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
                : "border-base-600 bg-base-800 text-ink-300"
            }
          >
            {decision.actionTaken}
          </Badge>
        </div>
      ))}
    </div>
  );
}
