"use client";

import { useRef } from "react";
import type { EntryPriceInfo, PaperTradeSide } from "@/lib/types";
import { formatCurrencyUSD, formatDateTime } from "@/lib/utils/format";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { dataSourceLabel } from "@/lib/utils/style";

interface PaperTradeModalProps {
  instrumentSymbol: string;
  instrumentName: string;
  side: PaperTradeSide;
  quantity: number | null;
  entryPriceInfo: EntryPriceInfo | null;
  isPriceLoading: boolean;
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
  entryPriceInfo,
  isPriceLoading,
  confidencePercent,
  strategyName,
  sourceLabel,
  onConfirm,
  onCancel,
}: PaperTradeModalProps) {
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const isReady = !isPriceLoading && entryPriceInfo !== null && quantity !== null;

  return (
    <Modal
      labelledBy="paper-trade-modal-title"
      describedBy="paper-trade-modal-description"
      onClose={onCancel}
      initialFocusRef={confirmButtonRef}
    >
      <div className="panel w-full max-w-md p-6">
        <h2 id="paper-trade-modal-title" className="text-base font-semibold text-ink-100">
          Confirm paper trade
        </h2>
        <p id="paper-trade-modal-description" className="mt-1 text-sm text-ink-400">
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
            <dd className="text-ink-100">{quantity === null ? "Calculating…" : quantity}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Entry price</dt>
            <dd className="text-ink-100">
              {entryPriceInfo === null ? "Fetching current price…" : formatCurrencyUSD(entryPriceInfo.price)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Price source</dt>
            <dd className="text-ink-100">
              {entryPriceInfo === null ? (
                "—"
              ) : (
                <Badge
                  className={
                    entryPriceInfo.source === "External"
                      ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
                      : "border-base-600 bg-base-800 text-ink-300"
                  }
                >
                  {entryPriceInfo.source === "External"
                    ? `${dataSourceLabel(entryPriceInfo.source)} · ${entryPriceInfo.provider}`
                    : dataSourceLabel(entryPriceInfo.source)}
                </Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-ink-500">Price last updated</dt>
            <dd className="text-ink-100">
              {entryPriceInfo === null ? "—" : formatDateTime(entryPriceInfo.timestamp)}
            </dd>
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

        {entryPriceInfo?.mode === "Fallback" ? (
          <div className="mt-5 rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
            Live market data was unavailable when this price was fetched — this trade uses a mock
            price instead.
          </div>
        ) : null}

        <div className="mt-5 rounded-xl2 border border-accent-amber/30 bg-accent-amber/10 px-4 py-3 text-xs leading-relaxed text-accent-amber">
          This is paper trading only. No real order will be placed.
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={!isReady} ref={confirmButtonRef}>
            Confirm paper trade
          </Button>
        </div>
      </div>
    </Modal>
  );
}
