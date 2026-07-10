"use client";

import { useRef } from "react";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

// Shown at most once per browser, and only when Supabase is the active store, has no trades of
// its own yet, and there's existing localStorage history to offer moving over. See
// PaperTradesProvider's hydration effect for exactly when importCandidate gets set.
export function ImportHistoryModal() {
  const { importCandidate, confirmImport, skipImport } = usePaperTrades();
  const importButtonRef = useRef<HTMLButtonElement>(null);

  if (!importCandidate) return null;

  return (
    <Modal
      labelledBy="import-history-modal-title"
      describedBy="import-history-modal-description"
      onClose={skipImport}
      initialFocusRef={importButtonRef}
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="import-history-modal-title" className="text-base font-semibold text-ink-100">
          Import existing paper trading history?
        </h2>
        <p id="import-history-modal-description" className="mt-2 text-sm leading-relaxed text-ink-400">
          This browser has {importCandidate.length} paper trade
          {importCandidate.length === 1 ? "" : "s"} saved locally, and your account&apos;s database
          has none yet. Import your local history so it&apos;s available wherever you sign in from
          now on, or skip to start fresh.
        </p>

        <div className="mt-5 rounded-xl2 border border-accent-blue/25 bg-accent-blue/10 px-4 py-3 text-xs leading-relaxed text-accent-blue">
          This is a one-time offer — once you choose, this browser won&apos;t ask again.
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={skipImport}>
            Skip
          </Button>
          <Button variant="primary" onClick={confirmImport} ref={importButtonRef}>
            Import
          </Button>
        </div>
      </div>
    </Modal>
  );
}
