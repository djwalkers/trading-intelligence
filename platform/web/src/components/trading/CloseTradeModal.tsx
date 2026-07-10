"use client";

import { useRef } from "react";
import type { PaperTradeSide } from "@/lib/types";
import { formatCurrencyUSD, formatPercent, formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

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
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <Modal
      labelledBy="close-trade-modal-title"
      describedBy="close-trade-modal-description"
      onClose={onCancel}
      initialFocusRef={confirmButtonRef}
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="close-trade-modal-title" className="text-base font-semibold text-ink-100">
          Close paper trade
        </h2>
        <p id="close-trade-modal-description" className="mt-1 text-sm text-ink-400">
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
          This is paper trading only. Closing this trade does not place a real order.
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={isPriceLoading || currentPrice === null}
            ref={confirmButtonRef}
          >
            Confirm close
          </Button>
        </div>
      </div>
    </Modal>
  );
}
