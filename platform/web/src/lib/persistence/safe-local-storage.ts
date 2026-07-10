import { logger } from "@/lib/logger/logger";

// Build 1.13.0 — every localStorage-backed store in this app wrote via a bare
// `window.localStorage.setItem(...)` with no try/catch around the write itself (only around
// reads) — a real gap for a full (quota-exceeded) or otherwise unavailable (private browsing in
// some older browsers, disabled storage) localStorage. Two variants, because the safe response
// differs by call site:
//
// - `setItemOrThrow`: for async store methods (`load`/`addTrade`/`addRecords`, etc.) that already
//   have a `.catch()` further up the call chain (see paper-trades-context.tsx, which logs and
//   shows a one-time "may not be saved" toast) — rethrowing a clean error lets that existing
//   handling do its job instead of silently losing the write.
// - `setItemSafely`: for call sites *inside* a React state updater function (e.g.
//   `setState((previous) => { ...localStorage.setItem...; return next; })`) — throwing there would
//   throw synchronously during React's state update with no surrounding try/catch, which is worse
//   than the write silently not persisting. Returns whether the write succeeded so the caller can
//   still choose to react (most just log, since these are lower-stakes preference/log stores).

function isStorageError(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown storage error";
}

export function setItemOrThrow(key: string, value: string, component: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    logger.error("localStorage write failed", {
      component,
      errorCode: "PERSISTENCE_ERROR",
      storageKey: key,
      reason: isStorageError(error),
    });
    throw new Error(`Failed to write to local storage (${key})`);
  }
}

export function setItemSafely(key: string, value: string, component: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch (error) {
    logger.error("localStorage write failed", {
      component,
      errorCode: "PERSISTENCE_ERROR",
      storageKey: key,
      reason: isStorageError(error),
    });
    return false;
  }
}
