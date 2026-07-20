import {
  Trading212Client,
  type Trading212Instrument,
  type Trading212Order,
  type Trading212TimeEvent,
} from "./trading212-client";
import type { PaperBroker } from "../paper-broker";
import type { AuditTrail } from "../audit-trail";
import type { Trading212DemoConfig } from "../config";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "../types";

const POLL_INTERVAL_MS = 1_100; // Trading212 rate-limits GET /orders/{id} to 1 / 1s
const MAX_POLL_ATTEMPTS = 8; // ~9 seconds total before giving up on an immediate fill

const TERMINAL_FAILURE_STATUSES = new Set(["CANCELLED", "REJECTED"]);

export type MarketSessionState = "OPEN" | "CLOSED" | "UNKNOWN";

// Trading212's documented behaviour (docs.trading212.com): "If placed when the market is closed,
// the order will be queued to execute when the market next opens" — a market order left in NEW
// indefinitely is expected, not a bug, whenever the instrument's exchange is closed. Confirmed
// against a live GET /equity/metadata/exchanges call: each working schedule is a chronological
// list of session-boundary events whose `type` always ends "OPEN" (session starting) or "CLOSE"
// (session ending) — the latest event at or before `now` tells us which state we're in.
export function resolveSessionState(timeEvents: Trading212TimeEvent[], now: Date): MarketSessionState {
  const past = timeEvents
    .filter((event) => new Date(event.date).getTime() <= now.getTime())
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
  const latest = past[past.length - 1];
  if (!latest) return "UNKNOWN";
  if (latest.type.endsWith("OPEN")) return "OPEN";
  if (latest.type.endsWith("CLOSE")) return "CLOSED";
  return "UNKNOWN";
}

/** Thrown when a submitted order hasn't reached FILLED (or a terminal failure) within the poll
 * window — e.g. outside market hours, or a slow demo-environment match. PaperBroker's contract
 * (mirroring LocalPaperBroker, which always fills instantly) has no concept of a still-pending
 * order — surfacing this distinctly, with the order id attached, is more honest than fabricating
 * a position that doesn't exist yet. The smoke test catches this and cancels the pending order. */
export class Trading212OrderPendingError extends Error {
  constructor(
    public readonly ticker: string,
    public readonly orderId: number,
  ) {
    super(`Order ${orderId} on ${ticker} did not reach FILLED within the poll window — cancel before retrying.`);
    this.name = "Trading212OrderPendingError";
  }
}

export interface Trading212BrokerDeps {
  config: Trading212DemoConfig;
  auditTrail: AuditTrail;
  executionRunId: string;
}

function roundQuantity(quantity: number): number {
  return Math.round(quantity * 1e8) / 1e8;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Behind the same PaperBroker interface LocalPaperBroker and HyperliquidTestnetBroker implement —
 * see docs/trading212-demo-adapter-phase-1.md for the full design.
 *
 * Trading212's public API has no market-quote endpoint, so (unlike the Hyperliquid adapter) this
 * broker never computes a slippage-bounded limit price — it submits plain market orders and polls
 * for a fill. It also has no dedicated "close position" endpoint: closing IS placing a market
 * order with the position's quantity negated (Trading212's own sign convention: positive quantity
 * buys, negative sells) — `closePosition()` and `placeMarketOrder()` share one internal
 * `submitOrder()` for exactly this reason.
 *
 * Only positions opened through this broker instance are tracked, same as the Hyperliquid
 * adapter — this is a connectivity/smoke-test adapter, not a general-purpose account manager.
 */
export class Trading212DemoBroker implements PaperBroker {
  private readonly client: Trading212Client;
  private readonly instrumentsByTicker = new Map<string, Trading212Instrument>();
  private readonly trackedPositions = new Map<string, PaperPosition>(); // keyed by ticker

  private account: Account = { cashBalance: 0, startingCashBalance: 0 };
  private completedTrades: CompletedTrade[] = [];
  private nextPositionSeq = 0;
  private nextTradeSeq = 0;
  private connected = false;

  constructor(private readonly deps: Trading212BrokerDeps) {
    const { config } = deps;
    if (!config.executionEnabled) {
      throw new Error("Trading212DemoBroker constructed without TRADING212_DEMO_EXECUTION_ENABLED=true.");
    }
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("Trading212DemoBroker requires both TRADING212_API_KEY and TRADING212_API_SECRET to be set.");
    }
    this.client = new Trading212Client(config.apiKey, config.apiSecret);
  }

  /** Establishes the tradeable-instrument list and an initial account snapshot. Must be called
   * once before any other method. */
  async connect(): Promise<void> {
    const { auditTrail, executionRunId } = this.deps;
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "BROKER_CONNECTION_ATTEMPTED",
      executionRunId,
      details: { provider: "trading212-demo" },
    });

    try {
      const [accountInfo, cash, instruments] = await Promise.all([
        this.client.getAccountInfo(),
        this.client.getAccountCash(),
        this.client.getInstruments(),
      ]);

      for (const instrument of instruments) this.instrumentsByTicker.set(instrument.ticker, instrument);

      this.account = { cashBalance: cash.free, startingCashBalance: cash.total };
      this.connected = true;

      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "BROKER_CONNECTION_SUCCEEDED",
        executionRunId,
        details: {
          currencyCode: accountInfo.currencyCode,
          instrumentsAvailable: instruments.length,
          cashFree: cash.free,
          cashTotal: cash.total,
        },
      });
    } catch (error) {
      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "BROKER_CONNECTION_FAILED",
        executionRunId,
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  hasInstrument(ticker: string): boolean {
    return this.instrumentsByTicker.has(ticker);
  }

  /** Best-effort diagnostic, not part of order placement itself: tells a caller (the smoke test)
   * whether `ticker`'s exchange is currently open, so a NEW order stuck at the poll timeout can be
   * explained ("market closed — queued to fill later") rather than treated as an unexplained
   * failure. Returns "UNKNOWN" if the instrument has no known working schedule, or if the
   * exchanges lookup itself fails — never throws. */
  async describeMarketSession(ticker: string): Promise<MarketSessionState> {
    const instrument = this.instrumentsByTicker.get(ticker);
    if (!instrument?.workingScheduleId) return "UNKNOWN";

    try {
      const exchanges = await this.client.getExchanges();
      for (const exchange of exchanges) {
        const schedule = exchange.workingSchedules.find((s) => s.id === instrument.workingScheduleId);
        if (schedule) return resolveSessionState(schedule.timeEvents, new Date());
      }
      return "UNKNOWN";
    } catch {
      return "UNKNOWN";
    }
  }

  getAccount(): Account {
    return { ...this.account };
  }

  getOpenPositions(): PaperPosition[] {
    return [...this.trackedPositions.values()];
  }

  getCompletedTrades(): CompletedTrade[] {
    return [...this.completedTrades];
  }

  /** The account's full open-positions list straight from Trading212 — for the smoke test's own
   * reporting. `getOpenPositions()` (the shared interface method) only ever reflects positions
   * opened through this broker instance; this returns everything Trading212 itself reports. */
  async getRawPortfolio(): Promise<unknown[]> {
    return this.client.getPortfolio();
  }

  /** Fetches an order's current status directly — satisfies "retrieve order status" without
   * requiring a full placeMarketOrder/closePosition cycle. */
  async getOrderStatus(orderId: number): Promise<Trading212Order> {
    return this.client.getOrder(orderId);
  }

  /** Cancels a pending order — used when placeMarketOrder/closePosition's poll times out.
   * Adapter-specific: LocalPaperBroker has no concept of a pending order to cancel. */
  async cancelOrder(ticker: string, orderId: number): Promise<void> {
    this.requireConnected();
    await this.client.cancelOrder(orderId);
    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_CANCELLED",
      executionRunId: this.deps.executionRunId,
      instrument: ticker,
      details: { orderId },
    });
  }

  async placeMarketOrder(order: OrderRequest): Promise<{ position: PaperPosition; orderId: string }> {
    this.requireConnected();
    if (order.side !== "BUY") {
      throw new Error(`Trading212DemoBroker.placeMarketOrder only opens long ("BUY") positions, got "${order.side}".`);
    }
    if (this.trackedPositions.has(order.instrument)) {
      throw new Error(
        `Strategy ${order.strategyId} already has an open position on ${order.instrument}; the broker refuses a second one.`,
      );
    }

    const filledOrder = await this.submitOrderAndPollForFill(order.instrument, roundQuantity(order.quantity), order);

    const avgPrice = filledOrder.filledValue! / filledOrder.filledQuantity!;
    this.nextPositionSeq += 1;
    const position: PaperPosition = {
      positionId: `t212-position-${this.nextPositionSeq}`,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      side: order.side,
      quantity: filledOrder.filledQuantity!,
      entryPrice: avgPrice,
      entryTimestamp: order.timestamp,
      entryOrderId: String(filledOrder.id),
      takeProfitPercent: order.takeProfitPercent,
      stopLossPercent: order.stopLossPercent,
    };
    this.trackedPositions.set(order.instrument, position);
    await this.refreshCashSnapshot();

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "POSITION_OPENED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { positionId: position.positionId, orderId: filledOrder.id, entryPrice: avgPrice },
    });

    return { position, orderId: String(filledOrder.id) };
  }

  async closePosition(
    positionId: string,
    exitPrice: number,
    exitTimestamp: string,
    closeReason: string,
  ): Promise<{ trade: CompletedTrade; orderId: string }> {
    this.requireConnected();
    const position = [...this.trackedPositions.values()].find((p) => p.positionId === positionId);
    if (!position) {
      throw new Error(`No open position ${positionId} — it may have already been closed.`);
    }

    const closeQuantity = -roundQuantity(position.quantity); // negative — Trading212's own sell convention
    const filledOrder = await this.submitOrderAndPollForFill(position.instrument, closeQuantity, {
      strategyId: position.strategyId,
      strategyVersion: position.strategyVersion,
      sourceType: position.sourceType,
      instrument: position.instrument,
    });

    const closeAvgPrice = filledOrder.filledValue! / filledOrder.filledQuantity!;
    this.nextTradeSeq += 1;
    const trade: CompletedTrade = {
      tradeId: `t212-trade-${this.nextTradeSeq}`,
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
      exitPrice: closeAvgPrice,
      exitTimestamp,
      exitOrderId: String(filledOrder.id),
      realisedPnl: (closeAvgPrice - position.entryPrice) * position.quantity,
      closeReason,
    };

    this.trackedPositions.delete(position.instrument);
    this.completedTrades.push(trade);
    await this.refreshCashSnapshot();

    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "POSITION_CLOSED",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { positionId: position.positionId, orderId: filledOrder.id, exitPrice: closeAvgPrice },
    });
    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "REALISED_PNL",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { tradeId: trade.tradeId, realisedPnl: trade.realisedPnl },
    });

    return { trade, orderId: String(filledOrder.id) };
  }

  /** Submits a signed-quantity market order (positive buys, negative sells — Trading212's own
   * convention) and polls GET /orders/{id} until it reaches FILLED or a terminal failure, or the
   * poll window is exhausted (Trading212OrderPendingError). Shared by placeMarketOrder (positive)
   * and closePosition (negative) — Trading212 has no separate close-position endpoint. */
  private async submitOrderAndPollForFill(
    ticker: string,
    signedQuantity: number,
    orderContext: Pick<OrderRequest, "strategyId" | "strategyVersion" | "sourceType" | "instrument">,
  ): Promise<Trading212Order> {
    // Every order — placeMarketOrder's and closePosition's — funnels through here, so this is the
    // one place a NaN/non-finite/zero quantity can be stopped before it ever reaches Trading212's
    // API. Fails locally with a clear error instead of ever submitting an invalid order.
    if (!Number.isFinite(signedQuantity) || signedQuantity === 0) {
      throw new Error(
        `Refusing to submit a Trading212 order for ${ticker}: computed quantity (${signedQuantity}) is not a valid non-zero finite number.`,
      );
    }

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_SUBMITTED",
      executionRunId: this.deps.executionRunId,
      strategyId: orderContext.strategyId,
      strategyVersion: orderContext.strategyVersion,
      sourceType: orderContext.sourceType,
      instrument: ticker,
      details: { quantity: signedQuantity },
    });

    let submitted = await this.client.placeMarketOrder(ticker, signedQuantity);

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_ACKNOWLEDGED",
      executionRunId: this.deps.executionRunId,
      strategyId: orderContext.strategyId,
      instrument: ticker,
      details: { orderId: submitted.id, status: submitted.status },
    });

    for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
      if (submitted.status === "FILLED") {
        await this.deps.auditTrail.record({
          timestamp: new Date().toISOString(),
          eventType: "ORDER_FILLED",
          executionRunId: this.deps.executionRunId,
          strategyId: orderContext.strategyId,
          instrument: ticker,
          details: {
            orderId: submitted.id,
            filledQuantity: submitted.filledQuantity,
            filledValue: submitted.filledValue,
          },
        });
        return submitted;
      }
      if (TERMINAL_FAILURE_STATUSES.has(submitted.status)) {
        throw new Error(`Trading212 order ${submitted.id} on ${ticker} ended as ${submitted.status}.`);
      }
      await sleep(POLL_INTERVAL_MS);
      submitted = await this.client.getOrder(submitted.id);
    }

    throw new Trading212OrderPendingError(ticker, submitted.id);
  }

  private async refreshCashSnapshot(): Promise<void> {
    const cash = await this.client.getAccountCash();
    this.account = { ...this.account, cashBalance: cash.free };
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("Trading212DemoBroker.connect() must be called before use.");
  }
}
