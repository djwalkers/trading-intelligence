"use client";

import { useEffect } from "react";
import { usePaperTrades } from "@/lib/state/paper-trades-context";

// Shown at most once per browser, and only when Supabase is the active store, has no trades of
// its own yet, and there's existing localStorage history to offer moving over. See
// PaperTradesProvider's hydration effect for exactly when importCandidate gets set.
export function ImportHistoryModal() {
  const { importCandidate, confirmImport, skipImport } = usePaperTrades();

  useEffect(() => {
    if (!importCandidate) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") skipImport();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importCandidate]);

  if (!importCandidate) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-history-modal-title"
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="import-history-modal-title" className="text-base font-semibold text-ink-100">
          Import existing paper trading history?
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-400">
          This browser has {importCandidate.length} paper trade
          {importCandidate.length === 1 ? "" : "s"} saved locally, and your connected Supabase
          project has none yet. Import your local history so it&apos;s available wherever you
          sign in from now on, or skip to start fresh in Supabase.
        </p>

        <div className="mt-5 rounded-xl2 border border-accent-blue/25 bg-accent-blue/10 px-4 py-3 text-xs leading-relaxed text-accent-blue">
          This is a one-time offer — once you choose, this browser won&apos;t ask again.
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={skipImport}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-400 transition-colors hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={confirmImport}
            autoFocus
            className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Import
          </button>
        </div>
      </div>
    </div>
  );
}
