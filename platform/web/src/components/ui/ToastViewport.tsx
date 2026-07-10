"use client";

import { useSyncExternalStore } from "react";
import { subscribeToToasts, getToastSnapshot, dismissToast, type Toast } from "@/lib/notifications/toast-bus";

const CATEGORY_CLASSES: Record<Toast["category"], string> = {
  success: "border-accent-teal/30 bg-base-900",
  info: "border-accent-blue/30 bg-base-900",
  warning: "border-accent-amber/30 bg-base-900",
  error: "border-accent-red/30 bg-base-900",
};

const CATEGORY_LABEL_CLASSES: Record<Toast["category"], string> = {
  success: "text-accent-teal",
  info: "text-accent-blue",
  warning: "text-accent-amber",
  error: "text-accent-red",
};

const CATEGORY_LABELS: Record<Toast["category"], string> = {
  success: "Success",
  info: "Info",
  warning: "Warning",
  error: "Error",
};

const EMPTY_TOASTS: Toast[] = [];

// Build 1.13.0 — mounted once in AppShell, alongside ImportHistoryModal/AutomationRunner. Reads
// the toast-bus external store via useSyncExternalStore (SSR-safe: `getServerSnapshot` always
// returns the same empty array, so there's no hydration mismatch regardless of what's been pushed
// client-side before this component's first paint). Positioned bottom-center on mobile (so it
// never sits over the Topbar's mobile nav strip, which is fixed to the top) and bottom-right on
// desktop.
export function ToastViewport() {
  const toasts = useSyncExternalStore(subscribeToToasts, getToastSnapshot, () => EMPTY_TOASTS);

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-4 sm:items-end"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.category === "error" ? "alert" : "status"}
          className={`panel pointer-events-auto flex w-full max-w-sm items-start gap-3 border px-4 py-3 ${CATEGORY_CLASSES[toast.category]}`}
        >
          <div className="flex flex-1 flex-col gap-0.5">
            <span className={`text-xs font-medium ${CATEGORY_LABEL_CLASSES[toast.category]}`}>
              {CATEGORY_LABELS[toast.category]}
            </span>
            <span className="text-sm text-ink-200">{toast.message}</span>
          </div>
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            className="rounded-md px-1.5 py-0.5 text-xs font-medium text-ink-500 transition-colors hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
