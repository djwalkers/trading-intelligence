"use client";

import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";

// Live, not mocked — mirrors PersistenceStatusPanel/MarketDataStatusPanel, reading directly from
// AuthContext rather than a static description of what was true when this build shipped.
export function AuthStatusPanel() {
  const { isConfigured, isLoading, user } = useAuth();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Auth</span>
          <span className="text-xs text-ink-500">
            {isConfigured
              ? "Supabase Auth is configured; sign-in is required to use this app."
              : "No Supabase project configured; the app runs in local prototype mode."}
          </span>
        </div>
        <Badge
          className={
            isConfigured
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isConfigured ? "Enabled" : "Disabled"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Current user</span>
          <span className="text-xs text-ink-500">
            {!isConfigured
              ? "Not applicable in local prototype mode"
              : user
                ? user.email
                : isLoading
                  ? "Checking session…"
                  : "No active session"}
          </span>
        </div>
        <Badge
          className={
            user
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isConfigured ? (user ? "Signed in" : "Not signed in") : "N/A"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Data scope</span>
          <span className="text-xs text-ink-500">
            {isConfigured
              ? "Paper trades are scoped to the signed-in user via Row Level Security."
              : "Paper trades are saved in this browser only, not scoped to any user."}
          </span>
        </div>
        <Badge
          className={
            isConfigured
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isConfigured ? "User scoped" : "Local prototype"}
        </Badge>
      </div>
    </div>
  );
}
