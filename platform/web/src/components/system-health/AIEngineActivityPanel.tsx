"use client";

import { Badge } from "@/components/ui/Badge";
import { useBotDecisionLog } from "@/lib/state/bot-decision-log-context";
import { formatDateTime } from "@/lib/utils/format";
import {
  MAX_CAPITAL_DEPLOYED_PERCENT,
  MAX_OPEN_TRADES,
  MAX_SECTOR_EXPOSURE_PERCENT,
  MAX_SECTOR_OPEN_TRADES,
  MAX_POSITION_VALUE_GBP,
  MIN_CONFIDENCE_IMPROVEMENT,
  MIN_ADD_INTERVAL_MINUTES,
} from "@/lib/bot";

// Build 1.12.0 — renamed from BotRunnerStatusPanel and trimmed: scheduling configuration (mode,
// interval, start/stop) moved to Settings (BrowserAutomationPanel/ServerAutomationPanel) since
// that's a configuration concern, not a health one. What's left here is purely observational: has
// the AI Engine scanned recently, what did it decide, and are its two safety layers (Portfolio Risk
// Manager, Position Protection) active — condensed to one line per limit group rather than one row
// per number, so this reads as a health summary, not a checklist. No thresholds changed.
export function AIEngineActivityPanel() {
  const { decisions, isHydrated } = useBotDecisionLog();
  const last = decisions[0] ?? null;
  const rejectedCount = last ? last.candidates.filter((candidate) => candidate.outcome === "Rejected").length : 0;

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">AI Engine</span>
          <span className="text-xs text-ink-500">
            Scans every watchlist instrument, ranks tradeable opportunities, and applies risk checks
            before opening any paper trade.
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last scan (this browser)</span>
          <span className="text-xs text-ink-500">
            {!isHydrated
              ? "Loading…"
              : last
                ? `${last.candidates.length} candidate${last.candidates.length === 1 ? "" : "s"} evaluated · ${rejectedCount} rejected`
                : "No scans recorded yet in this browser"}
          </span>
        </div>
        <span className="text-sm text-ink-300">
          {!isHydrated ? "…" : last ? formatDateTime(last.timestamp) : "Never run"}
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last decision</span>
          <span className="max-w-md text-xs text-ink-500">
            {!isHydrated ? "Loading…" : (last?.reason ?? "No decisions recorded yet in this browser.")}
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
          <span className="text-sm font-medium text-ink-100">Portfolio Risk Manager</span>
          <span className="text-xs text-ink-500">
            Max {MAX_OPEN_TRADES} open positions · {MAX_CAPITAL_DEPLOYED_PERCENT}% of capital
            deployed · {MAX_SECTOR_EXPOSURE_PERCENT}% per sector (max {MAX_SECTOR_OPEN_TRADES}{" "}
            trades/sector)
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Position Protection</span>
          <span className="text-xs text-ink-500">
            Max £{MAX_POSITION_VALUE_GBP} per instrument · requires +{MIN_CONFIDENCE_IMPROVEMENT}{" "}
            confidence and {MIN_ADD_INTERVAL_MINUTES} minutes before adding to an existing position
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>
    </div>
  );
}
