"use client";

import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/lib/auth/auth-context";

// Live, not mocked — mirrors DatabaseStatusPanel/MarketDataStatusPanel, reading directly from
// AuthContext rather than a static description of what was true when this build shipped.
export function AuthStatusPanel() {
  const { isConfigured, isLoading, user } = useAuth();

  return (
    <div className="divide-y divide-base-700/60">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Account sign-in</span>
          <span className="text-xs text-ink-500">
            {isConfigured
              ? "Sign-in is required to use this app, and your data is kept separate from other users."
              : "No account system is connected; the app runs in single-user local mode."}
          </span>
        </div>
        <Badge
          className={
            isConfigured
              ? "border-accent-teal/30 bg-accent-teal/10 text-accent-teal"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isConfigured ? "Enabled" : "Local mode"}
        </Badge>
      </div>

      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-medium text-ink-100">Current user</span>
          <span className="text-xs text-ink-500">
            {!isConfigured
              ? "Not applicable in local mode"
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
              ? "Your paper trades are only ever visible to your own signed-in account."
              : "Your paper trades are saved in this browser only, not tied to any account."}
          </span>
        </div>
        <Badge
          className={
            isConfigured
              ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
              : "border-base-600 bg-base-800 text-ink-300"
          }
        >
          {isConfigured ? "Per-user" : "This browser"}
        </Badge>
      </div>
    </div>
  );
}
