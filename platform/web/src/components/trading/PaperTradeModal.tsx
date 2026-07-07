"use client";

import { useEffect } from "react";
import type { PaperTradeSide } from "@/lib/types";
import { formatCurrencyUSD } from "@/lib/utils/format";

interface PaperTradeModalProps {
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  quantity: number;
  entryPrice: number;
  confidencePercent: number;
  strategyName: string;
  sourceLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function PaperTradeModal({
  instrumentSymbol,
  instrumentName,
  side,
  quantity,
  entryPrice,
  confidencePercent,
  strategyName,
  sourceLabel,
  onConfirm,
  onCancel,
}: PaperTradeModalProps) {
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paper-trade-modal-title"
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="paper-trade-modal-title" className="text-base font-semibold text-ink-100">
          Confirm paper trade
        </h2>
        <p className="mt-1 text-sm text-ink-400">
          Review the details before placing this simulated trade.
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {sourceLabel ? (
            <div>
              <dt className="text-xs text-ink-500">Source</dt>
              <dd className="text-ink-100">{sourceLabel}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-xs text-ink-500">Instrument</dt>
            <dd className="text-ink-100">
              {instrumentSymbol} &middot; {instrumentName}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Side</dt>
            <dd className="text-ink-100">{side}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Quantity</dt>
            <dd className="text-ink-100">{quantity}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Entry price</dt>
            <dd className="text-ink-100">{formatCurrencyUSD(entryPrice)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Strategy</dt>
            <dd className="text-ink-100">{strategyName}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Confidence</dt>
            <dd className="text-ink-100">{confidencePercent}%</dd>
          </div>
        </dl>

        <div className="mt-5 rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
          This is prototype paper trading only. No real order will be placed.
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-4 py-2 text-sm font-medium text-ink-400 transition-colors hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            autoFocus
            className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Confirm paper trade
          </button>
        </div>
      </div>
    </div>
  );
}
