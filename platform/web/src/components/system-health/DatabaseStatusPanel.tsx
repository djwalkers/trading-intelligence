"use client";

import { Badge } from "@/components/ui/Badge";
import { usePersistenceStatus } from "@/lib/state/use-persistence-status";
import { formatDateTime } from "@/lib/utils/format";

// Build 1.12.0 — renamed from PersistenceStatusPanel ("Database" is the term users see; the
// underlying store abstraction and its mode values are unchanged). Live, not mocked — reads the
// same status the store itself tracks, so this always reflects what's actually happening.
export function DatabaseStatusPanel() {
  const status = usePersistenceStatus();
  const isDatabaseBacked = status.mode === "Supabase";

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Storage</span>
          <span className="text-xs text-ink-500">
            {isDatabaseBacked
              ? "Your data is saved to a database, so it's available on any device you sign in from."
              : "Your data is saved in this browser only."}
          </span>
        </div>
        <Badge
          className={
            isDatabaseBacked
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isDatabaseBacked ? "Database" : "This browser"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Connection</span>
          {status.fallbackReason ? (
            <span className="text-xs text-accent-amber">{status.fallbackReason}</span>
          ) : (
            <span className="text-xs text-ink-500">
              {isDatabaseBacked ? "Connected" : "No connection needed"}
            </span>
          )}
        </div>
        <Badge
          className={
            status.connected
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-accent-red/30 bg-accent-red/10 text-accent-red"
          }
        >
          {status.connected ? "Connected" : "Disconnected"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Last synchronisation</span>
          <span className="text-xs text-ink-500">Most recent successful read or write</span>
        </div>
        <span className="text-sm text-ink-300">
          {status.lastSyncedAt ? formatDateTime(status.lastSyncedAt) : "Not yet synced"}
        </span>
      </div>
    </div>
  );
}
