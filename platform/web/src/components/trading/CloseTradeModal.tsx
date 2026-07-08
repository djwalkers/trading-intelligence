"use client";

import { useEffect } from "react";
import type { PaperTradeSide } from "@/lib/types";
import { formatCurrencyUSD, formatPercent, formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

interface CloseTradeModalProps {
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  quantity: number;
  entryPrice: number;
  currentPrice: number | null;
  isPriceLoading: boolean;
  estimatedPnl: number;
  estimatedPnlPercent: number;
  onConfirm: () => void;
  onCancel: () => void;
}

export function CloseTradeModal({
  instrumentSymbol,
  instrumentName,
  side,
  quantity,
  entryPrice,
  currentPrice,
  isPriceLoading,
  estimatedPnl,
  estimatedPnlPercent,
  onConfirm,
  onCancel,
}: CloseTradeModalProps) {
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
      aria-labelledby="close-trade-modal-title"
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="close-trade-modal-title" className="text-base font-semibold text-ink-100">
          Close paper trade
        </h2>
        <p className="mt-1 text-sm text-ink-400">
          Review the estimated outcome before closing this simulated position.
        </p>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
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
            <dt className="text-xs text-ink-500">Current price</dt>
            <dd className="text-ink-100">
              {isPriceLoading || currentPrice === null
                ? "Fetching current price…"
                : formatCurrencyUSD(currentPrice)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Estimated realised P/L</dt>
            <dd className={`font-medium ${plToneClass(estimatedPnl)}`}>
              {isPriceLoading || currentPrice === null
                ? "—"
                : `${formatSignedNumber(estimatedPnl)} (${formatPercent(estimatedPnlPercent)})`}
            </dd>
          </div>
        </dl>

        <div className="mt-5 rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
          This is prototype paper trading only. Closing this trade does not place a real order.
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
            disabled={isPriceLoading || currentPrice === null}
            autoFocus
            className="rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-4 py-2 text-sm font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Confirm close
          </button>
        </div>
      </div>
    </div>
  );
}
