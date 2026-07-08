"use client";

import { Badge } from "@/components/ui/Badge";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { formatDateTime } from "@/lib/utils/format";

// Live, not mocked — reads the same local decision log the Dashboard's "Run Bot Scan" button
// writes to and the Bot Decisions page reads from.
export function BotRunnerStatusPanel() {
  const { decisions } = useBotDecisionLog();
  const last = decisions[0] ?? null;
  const rejectedCount = last ? last.candidates.filter((candidate) => candidate.outcome === "Rejected").length : 0;

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Bot Runner</span>
          <span className="text-xs text-ink-500">
            Triggered manually from the Dashboard — no scheduled or autonomous runs in this build.
          </span>
        </div>
        <Badge className="border-base-600 bg-base-800 text-ink-300">Manual Mode</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last bot scan</span>
          <span className="text-xs text-ink-500">
            {last ? last.scanId : "Most recent “Run Bot Scan” click"}
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {last ? formatDateTime(last.timestamp) : "Never run"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last bot action</span>
          <span className="max-w-md text-xs text-ink-500">
            {last?.reason ?? "No scans recorded yet in this browser."}
          </span>
        </div>
        <Badge
          className={
            last?.tradeCreated
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {last ? last.actionTaken : "—"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last scan candidates</span>
          <span className="text-xs text-ink-500">Evaluated vs. rejected before the outcome above</span>
        </div>
        <span className="text-sm text-ink-300">
          {last ? `${last.candidates.length} evaluated · ${rejectedCount} rejected` : "—"}
        </span>
      </div>
    </div>
  );
}
