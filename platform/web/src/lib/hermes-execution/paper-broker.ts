import { at } from "./array-utils";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "./types";
import { initialPaperBrokerState, type PaperBrokerState, type PaperBrokerStore } from "./paper-broker-store";

/** Only what the current requirements need — get account, get open positions, place a market
 * order, close a position, get completed trades. A future real/paper-with-a-real-broker
 * implementation only needs to satisfy this same interface. */
export interface PaperBroker {
  getAccount(): Account;
  getOpenPositions(): PaperPosition[];
  getCompletedTrades(): CompletedTrade[];
  placeMarketOrder(order: OrderRequest): Promise<{ position: PaperPosition; orderId: string }>;
  closePosition(
    positionId: string,
    exitPrice: number,
    exitTimestamp: string,
    closeReason: string,
  ): Promise<{ trade: CompletedTrade; orderId: string }>;
}

/**
 * A local, filesystem/in-memory-backed paper broker (no real order ever leaves this process — see
 * docs/execution-mvp-phase-1.md's Safety Boundaries). State is loaded once via `create()` and kept
 * in memory thereafter; every mutating call re-persists the full state through the injected store
 * so a crash mid-replay still leaves the last-good state on disk (for the JSON file store) rather
 * than losing everything.
 */
export class LocalPaperBroker implements PaperBroker {
  private state: PaperBrokerState;

  private constructor(
    private readonly store: PaperBrokerStore,
    initialState: PaperBrokerState,
  ) {
    this.state = initialState;
  }

  /** `resetState: true` always starts from a fresh account/position/trade-count-zero state — used
   * by the demo CLI so every replay is byte-for-byte reproducible regardless of what a previous
   * run left on disk. `resetState: false` loads whatever the store already has (or initializes
   * fresh if nothing is persisted yet) — the shape a long-running process would want instead. */
  static async create(
    store: PaperBrokerStore,
    startingCash: number,
    options: { resetState: boolean },
  ): Promise<LocalPaperBroker> {
    const loaded = options.resetState ? null : await store.load();
    const state = loaded ?? initialPaperBrokerState(startingCash);
    const broker = new LocalPaperBroker(store, state);
    await store.save(state);
    return broker;
  }

  getAccount(): Account {
    return { ...this.state.account };
  }

  getOpenPositions(): PaperPosition[] {
    return this.state.openPositions.map((p) => ({ ...p }));
  }

  getCompletedTrades(): CompletedTrade[] {
    return this.state.completedTrades.map((t) => ({ ...t }));
  }

  async placeMarketOrder(order: OrderRequest): Promise<{ position: PaperPosition; orderId: string }> {
    if (order.side !== "BUY") {
      throw new Error(`LocalPaperBroker only supports opening long ("BUY") positions in this phase, got "${order.side}".`);
    }
    if (order.quantity <= 0) {
      throw new Error(`Order quantity must be positive, got ${order.quantity}.`);
    }
    const orderValue = order.quantity * order.price;
    if (orderValue > this.state.account.cashBalance) {
      throw new Error(
        `Insufficient paper cash: order value ${orderValue.toFixed(2)} exceeds available cash ${this.state.account.cashBalance.toFixed(2)}.`,
      );
    }
    const hasDuplicate = this.state.openPositions.some(
      (p) => p.strategyId === order.strategyId && p.instrument === order.instrument,
    );
    if (hasDuplicate) {
      throw new Error(
        `Strategy ${order.strategyId} already has an open position on ${order.instrument}; the broker refuses a second one.`,
      );
    }

    this.state.nextOrderSeq += 1;
    this.state.nextPositionSeq += 1;
    const orderId = `order-${this.state.nextOrderSeq}`;
    const positionId = `position-${this.state.nextPositionSeq}`;

    const position: PaperPosition = {
      positionId,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      side: order.side,
      quantity: order.quantity,
      entryPrice: order.price,
      entryTimestamp: order.timestamp,
      entryOrderId: orderId,
      takeProfitPercent: order.takeProfitPercent,
      stopLossPercent: order.stopLossPercent,
    };

    this.state.account.cashBalance -= orderValue;
    this.state.openPositions.push(position);
    await this.store.save(this.state);

    return { position: { ...position }, orderId };
  }

  async closePosition(
    positionId: string,
    exitPrice: number,
    exitTimestamp: string,
    closeReason: string,
  ): Promise<{ trade: CompletedTrade; orderId: string }> {
    const index = this.state.openPositions.findIndex((p) => p.positionId === positionId);
    if (index === -1) {
      throw new Error(`No open position ${positionId} — it may have already been closed.`);
    }
    const position = at(this.state.openPositions, index);

    this.state.nextOrderSeq += 1;
    this.state.nextTradeSeq += 1;
    const orderId = `order-${this.state.nextOrderSeq}`;
    const tradeId = `trade-${this.state.nextTradeSeq}`;

    const direction = position.side === "BUY" ? 1 : -1;
    const realisedPnl = (exitPrice - position.entryPrice) * position.quantity * direction;
    const proceeds = position.quantity * exitPrice;

    const trade: CompletedTrade = {
      tradeId,
      positionId: position.positionId,
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      sourceType: position.sourceType,
      instrument: position.instrument,
      side: position.side,
      quantity: position.quantity,
      entryPrice: position.entryPrice,
      entryTimestamp: position.entryTimestamp,
      entryOrderId: position.entryOrderId,
      exitPrice,
      exitTimestamp,
      exitOrderId: orderId,
      realisedPnl,
      closeReason,
    };

    this.state.account.cashBalance += proceeds;
    this.state.openPositions.splice(index, 1);
    this.state.completedTrades.push(trade);
    await this.store.save(this.state);

    return { trade: { ...trade }, orderId };
  }
}
