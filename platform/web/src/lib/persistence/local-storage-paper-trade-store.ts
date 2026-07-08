import type { PaperTrade } from "@/lib/types";
import type { PaperTradeStore } from "./paper-trade-store";

const STORAGE_KEY = "trading-intelligence.paper-trades.v1";

// Trades saved before Build 0.4.0 have no `source` field on disk, even though the type now
// requires one — treat them as Signal-sourced, since that was the only paper trade flow that
// existed at the time. Every field added since (source, intelligence, exitPrice, closedAt,
// realisedPnl, realisedPnlPercent) is optional on the type, so no other migration is needed.
function normalizeTrade(trade: Partial<PaperTrade>): PaperTrade {
  return { source: "Signal", ...trade } as PaperTrade;
}

export class LocalStoragePaperTradeStore implements PaperTradeStore {
  async load(): Promise<PaperTrade[]> {
    if (typeof window === "undefined") return [];

    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as Partial<PaperTrade>[];
      return parsed.map(normalizeTrade);
    } catch {
      // Corrupt or inaccessible storage — start from an empty trade log.
      return [];
    }
  }

  async addTrade(trade: PaperTrade): Promise<void> {
    const current = await this.load();
    await this.writeAll([trade, ...current]);
  }

  async closeTrade(closedTrade: PaperTrade): Promise<void> {
    const current = await this.load();
    const next = current.map((trade) => (trade.id === closedTrade.id ? closedTrade : trade));
    await this.writeAll(next);
  }

  private async writeAll(trades: PaperTrade[]): Promise<void> {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(trades));
  }
}
