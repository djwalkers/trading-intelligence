"use client";

import type { Signal } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { formatDateTime } from "@/lib/utils/format";
import { signalToneClasses } from "@/lib/utils/style";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { usePaperTradeEntryFlow } from "@/lib/state/use-paper-trade-entry-flow";
import { buildPaperTradeFromSignal, isTradeableSignal, quantityForEntryPrice } from "@/lib/utils/paper-trade";
import { PaperTradeModal } from "@/components/trading/PaperTradeModal";

interface SignalsTableProps {
  signals: Signal[];
}

export function SignalsTable({ signals }: SignalsTableProps) {
  const { addTrade, hasTradeForSignal } = usePaperTrades();
  const { pendingSource, entryPriceInfo, isPriceLoading, requestTrade, cancelTrade } =
    usePaperTradeEntryFlow<Signal>();

  if (signals.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No signals generated yet.</p>;
  }

  function handleConfirm() {
    if (pendingSource && entryPriceInfo) {
      addTrade(buildPaperTradeFromSignal(pendingSource, entryPriceInfo));
    }
    cancelTrade();
  }

  return (
    <>
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
              <th className="px-5 py-2.5 font-medium">Instrument</th>
              <th className="px-5 py-2.5 font-medium">Signal</th>
              <th className="px-5 py-2.5 font-medium">Confidence</th>
              <th className="px-5 py-2.5 font-medium">Strategy</th>
              <th className="px-5 py-2.5 font-medium">Reason</th>
              <th className="px-5 py-2.5 font-medium">Generated</th>
              <th className="px-5 py-2.5 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {signals.map((signal) => {
              const tradeable = isTradeableSignal(signal);
              const alreadyTraded = hasTradeForSignal(signal.id);

              return (
                <tr key={signal.id} className="border-b border-base-700/60 last:border-0">
                  <td className="px-5 py-2.5">
                    <div className="flex flex-col">
                      <span className="font-medium text-ink-100">{signal.instrumentSymbol}</span>
                      <span className="text-xs text-ink-500">{signal.instrumentName}</span>
                    </div>
                  </td>
                  <td className="px-5 py-2.5">
                    <Badge className={signalToneClasses(signal.signalType)}>{signal.signalType}</Badge>
                  </td>
                  <td className="px-5 py-2.5 text-ink-300">{signal.confidencePercent}%</td>
                  <td className="px-5 py-2.5 text-ink-300">{signal.strategyName}</td>
                  <td className="px-5 py-2.5 max-w-xs text-ink-400">{signal.reason}</td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                    {formatDateTime(signal.timestamp)}
                  </td>
                  <td className="px-5 py-2.5">
                    {!tradeable ? (
                      <span className="text-xs text-ink-600">Not tradeable</span>
                    ) : alreadyTraded ? (
                      <Badge className="border-base-600 bg-base-800 text-ink-400">Trade placed</Badge>
                    ) : (
                      <button
                        type="button"
                        onClick={() => requestTrade(signal.instrumentSymbol, signal)}
                        className="whitespace-nowrap rounded-lg border border-accent-teal/30 bg-accent-teal/10 px-3 py-1.5 text-xs font-medium text-accent-teal transition-colors hover:bg-accent-teal/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
                      >
                        Paper Trade
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pendingSource ? (
        <PaperTradeModal
          instrumentSymbol={pendingSource.instrumentSymbol}
          instrumentName={pendingSource.instrumentName}
          side={pendingSource.signalType === "SELL" ? "SELL" : "BUY"}
          quantity={entryPriceInfo ? quantityForEntryPrice(entryPriceInfo.price) : null}
          entryPriceInfo={entryPriceInfo}
          isPriceLoading={isPriceLoading}
          confidencePercent={pendingSource.confidencePercent}
          strategyName={pendingSource.strategyName}
          onConfirm={handleConfirm}
          onCancel={cancelTrade}
        />
      ) : null}
    </>
  );
}
