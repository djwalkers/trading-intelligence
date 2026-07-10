"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { ServerScheduleRow } from "@/lib/scheduler/client-schedule-store";
import { getClientScheduleStore } from "@/lib/scheduler/get-client-schedule-store";
import { AuthRequiredError } from "@/lib/persistence/auth-required-error";
import { useAuth } from "@/lib/auth/auth-context";

// How often to re-read the schedule row while this provider is mounted and available — the VPS
// worker (Mission 8) writes to this same row independently of anything happening in this browser
// tab (locked_at/locked_by, last_scan_at, last_status, last_error, next_scan_at all get updated
// after a real scan runs), so without a poll the Server Schedule panel would silently go stale the
// moment a worker-driven scan completes.
const POLL_INTERVAL_MS = 45_000;

interface ServerScheduleContextValue {
  schedule: ServerScheduleRow | null;
  // True only once Supabase is configured, auth has resolved, and a user is signed in — the only
  // state in which a server schedule means anything. The Server Schedule panel uses this to show
  // an explicit "unavailable" state rather than empty controls that quietly do nothing.
  isAvailable: boolean;
  isHydrated: boolean;
  error: string | null;
  save: (enabled: boolean, intervalMinutes: number) => Promise<ServerScheduleRow>;
}

const ServerScheduleContext = createContext<ServerScheduleContextValue | null>(null);

interface LoadedSchedule {
  key: string;
  schedule: ServerScheduleRow | null;
}

export function ServerScheduleProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState<LoadedSchedule>({ key: "", schedule: null });
  const [error, setError] = useState<string | null>(null);
  const { isConfigured, isLoading: isAuthLoading, user } = useAuth();

  // Same "whose data should currently be loaded" pattern as DecisionHistoryProvider/
  // PaperTradesProvider — re-hydrates whenever the signed-in identity changes.
  const authKey = !isConfigured ? "local" : isAuthLoading ? "pending" : (user?.id ?? "unauthenticated");
  const isHydrated = loaded.key === authKey;
  const isAvailable = isConfigured && !isAuthLoading && user !== null;
  const schedule = isHydrated ? loaded.schedule : null;

  useEffect(() => {
    if (authKey === "pending") return;

    let cancelled = false;

    async function hydrate() {
      // Ensures every setLoaded call below happens after at least one microtask tick, never
      // synchronously within the effect body itself — this project's React Compiler-style lint
      // rules flag a setState call reachable without an intervening await as "synchronous within
      // an effect," even when it's inside a separately-defined async function like this one.
      await Promise.resolve();
      if (cancelled) return;

      if (!isAvailable) {
        setLoaded({ key: authKey, schedule: null });
        return;
      }

      const store = getClientScheduleStore();
      if (!store) {
        setLoaded({ key: authKey, schedule: null });
        return;
      }
      try {
        const result = await store.load();
        if (!cancelled) {
          setLoaded({ key: authKey, schedule: result });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setLoaded({ key: authKey, schedule: null });
          // AuthRequiredError here means the session lapsed between isAvailable becoming true and
          // this call resolving — not worth surfacing as an error, the next auth-state change will
          // re-hydrate correctly.
          if (!(err instanceof AuthRequiredError)) {
            setError(err instanceof Error ? err.message : "Unknown error loading server schedule.");
          }
        }
      }
    }

    hydrate();

    return () => {
      cancelled = true;
    };
  }, [authKey, isAvailable]);

  useEffect(() => {
    if (!isAvailable) return;

    const timer = setInterval(() => {
      const store = getClientScheduleStore();
      if (!store) return;
      store
        .load()
        .then((result) => setLoaded({ key: authKey, schedule: result }))
        .catch(() => {
          // A transient poll failure — leave the last-known schedule displayed rather than
          // clearing it or surfacing an error for a background refresh the user didn't ask for.
        });
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [isAvailable, authKey]);

  async function save(enabled: boolean, intervalMinutes: number): Promise<ServerScheduleRow> {
    const store = getClientScheduleStore();
    if (!store) throw new Error("Supabase is not configured — server scheduling is unavailable.");

    const updated = await store.save(enabled, intervalMinutes);
    setLoaded({ key: authKey, schedule: updated });
    setError(null);
    return updated;
  }

  return (
    <ServerScheduleContext.Provider value={{ schedule, isAvailable, isHydrated, error, save }}>
      {children}
    </ServerScheduleContext.Provider>
  );
}

export function useServerSchedule() {
  const context = useContext(ServerScheduleContext);
  if (!context) {
    throw new Error("useServerSchedule must be used within a ServerScheduleProvider");
  }
  return context;
}
