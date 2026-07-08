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

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Portfolio Risk Manager</span>
          <span className="text-xs text-ink-500">
            Evaluates whole-portfolio exposure before the bot opens any trade (Mission 2).
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Open trade limit</span>
          <span className="text-xs text-ink-500">Maximum open bot trades at once</span>
        </div>
        <span className="text-sm text-ink-300">{MAX_OPEN_TRADES} open trades</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Capital deployment limit</span>
          <span className="text-xs text-ink-500">Share of starting paper capital deployed</span>
        </div>
        <span className="text-sm text-ink-300">{MAX_CAPITAL_DEPLOYED_PERCENT}% of starting capital</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Sector exposure limit</span>
          <span className="text-xs text-ink-500">Per-sector exposure and open trade count</span>
        </div>
        <span className="text-sm text-ink-300">
          {MAX_SECTOR_EXPOSURE_PERCENT}% · max {MAX_SECTOR_OPEN_TRADES} trades/sector
        </span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Position Manager</span>
          <span className="text-xs text-ink-500">
            Classifies a candidate against any existing position before opening a trade (Mission 3).
          </span>
        </div>
        <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal">Active</Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Max instrument position</span>
          <span className="text-xs text-ink-500">Total value allowed in one instrument</span>
        </div>
        <span className="text-sm text-ink-300">£{MAX_POSITION_VALUE_GBP}</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Add-to-position confidence improvement</span>
          <span className="text-xs text-ink-500">Minimum improvement over the last Bot trade to add</span>
        </div>
        <span className="text-sm text-ink-300">+{MIN_CONFIDENCE_IMPROVEMENT}</span>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Minimum add interval</span>
          <span className="text-xs text-ink-500">Time required since the last trade in an instrument</span>
        </div>
        <span className="text-sm text-ink-300">{MIN_ADD_INTERVAL_MINUTES} minutes</span>
      </div>
    </div>
  );
}
