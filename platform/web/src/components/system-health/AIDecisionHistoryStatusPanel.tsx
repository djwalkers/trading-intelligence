"use client";

import { Badge } from "@/components/ui/Badge";
import { useDecisionHistoryStatus } from "@/lib/state/use-decision-history-status";
import { formatDateTime } from "@/lib/utils/format";

// Build 1.12.0 — renamed from DecisionIntelligenceStatusPanel. Live, not mocked — reads the same
// status the AI Decision History page's own persistence note reflects.
export function AIDecisionHistoryStatusPanel() {
  const status = useDecisionHistoryStatus();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Status</span>
          <span className="text-xs text-ink-500">
            {status.fallbackReason
              ? status.fallbackReason
              : status.mode === "Supabase"
                ? "Recording every AI decision to your database."
                : "Recording every AI decision in this browser only."}
          </span>
        </div>
        <Badge
          className={
            status.mode === "Supabase"
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {status.mode === "Supabase" ? "Database" : "This browser"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Decisions recorded</span>
          <span className="text-xs text-ink-500">
            Every candidate the AI Engine has considered — accepted and rejected alike
          </span>
        </div>
        <span className="text-sm text-ink-300">{status.recordsStored}</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last recorded</span>
          <span className="text-xs text-ink-500">Most recent decision written</span>
        </div>
        <span className="text-sm text-ink-300">
          {status.lastRecordedAt ? formatDateTime(status.lastRecordedAt) : "Never recorded"}
        </span>
      </div>
    </div>
  );
}
