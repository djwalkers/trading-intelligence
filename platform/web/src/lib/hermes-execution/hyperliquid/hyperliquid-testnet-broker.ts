import { HttpTransport, InfoClient, ExchangeClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";
import { formatPerpPrice, formatPerpSize } from "./price-formatting";
import type { PaperBroker } from "../paper-broker";
import type { AuditTrail } from "../audit-trail";
import type { HyperliquidTestnetConfig } from "../config";
import type { Account, CompletedTrade, OrderRequest, PaperPosition } from "../types";

/**
 * Hyperliquid-specific response shapes stay local to this file — nothing outside this adapter
 * ever sees a raw Hyperliquid type. Only the subset actually used is declared; the SDK's own
 * types are intentionally not re-exported here to keep the translation boundary explicit.
 *
 * No `{ error: string }` variant is declared here: the SDK's `order()`/`cancel()` calls already
 * throw `ApiRequestError` for any error-shaped response (per-item or top-level) before ever
 * resolving — by the time a call resolves successfully, no item in it can be an error. Callers
 * of this adapter should catch `ApiRequestError` around order/cancel operations instead.
 */
interface OrderStatusFilled {
  filled: { totalSz: string; avgPx: string; oid: number; cloid?: string };
}
interface OrderStatusResting {
  resting: { oid: number; cloid?: string };
}

/** Thrown when a submitted order didn't fill immediately. PaperBroker's contract (mirroring
 * LocalPaperBroker, which always fills instantly) has no concept of a resting order — surfacing
 * this distinctly, with the oid attached, is more honest than fabricating a position that doesn't
 * exist yet. The smoke-test command catches this and cancels the resting order. */
export class HyperliquidOrderRestingError extends Error {
  constructor(
    public readonly coin: string,
    public readonly oid: number,
  ) {
    super(`Order on ${coin} did not fill immediately and is resting as oid=${oid} — cancel before retrying.`);
    this.name = "HyperliquidOrderRestingError";
  }
}

export interface HyperliquidBrokerDeps {
  config: HyperliquidTestnetConfig;
  auditTrail: AuditTrail;
  executionRunId: string;
}

/**
 * Behind the same PaperBroker interface LocalPaperBroker implements — see
 * docs/hyperliquid-testnet-adapter-phase-1.md for the full design.
 *
 * getAccount()/getOpenPositions()/getCompletedTrades() are synchronous per the shared interface,
 * but live exchange state can only be read asynchronously — so this adapter keeps a cached
 * snapshot, refreshed by connect() and by every placeMarketOrder()/closePosition() call. It is
 * never a live poll; callers needing the absolute latest state should call connect() again.
 *
 * Only positions opened through THIS broker instance are tracked (this is a smoke-test adapter,
 * not a general-purpose account manager) — any pre-existing position on the account is invisible
 * to getOpenPositions() by design.
 */
export class HyperliquidTestnetBroker implements PaperBroker {
  private readonly transport: HttpTransport;
  private readonly info: InfoClient;
  private readonly exchange: ExchangeClient;

  private readonly assetIndexByCoin = new Map<string, number>();
  private readonly szDecimalsByCoin = new Map<string, number>();
  private readonly trackedPositions = new Map<string, PaperPosition>(); // keyed by coin
  private readonly submittedCloids = new Set<string>();

  private account: Account = { cashBalance: 0, startingCashBalance: 0 };
  private completedTrades: CompletedTrade[] = [];
  private nextPositionSeq = 0;
  private nextTradeSeq = 0;
  private nextCloidSeq = 0;
  private connected = false;

  constructor(private readonly deps: HyperliquidBrokerDeps) {
    const { config } = deps;
    if (!config.executionEnabled) {
      throw new Error("HyperliquidTestnetBroker constructed without HYPERLIQUID_TESTNET_EXECUTION_ENABLED=true.");
    }
    if (!config.privateKey || !config.accountAddress) {
      throw new Error("HyperliquidTestnetBroker requires both a private key and an account address.");
    }

    // Hard-coded true — never derived from any config value, so there is no code path that could
    // ever point this adapter at a mainnet endpoint.
    this.transport = new HttpTransport({ isTestnet: true });
    if (!this.transport.isTestnet) {
      // Defense in depth: even if the SDK's own default ever changed, refuse to proceed silently.
      throw new Error("HyperliquidTestnetBroker refuses to run against a non-testnet transport.");
    }

    const wallet = privateKeyToAccount(config.privateKey as `0x${string}`);
    this.info = new InfoClient({ transport: this.transport });
    this.exchange = new ExchangeClient({ transport: this.transport, wallet });
  }

  /** Establishes the asset universe and an initial account snapshot. Must be called once before
   * any other method. Not part of the shared PaperBroker interface — LocalPaperBroker has no
   * equivalent connection step. */
  async connect(): Promise<void> {
    const { auditTrail, executionRunId } = this.deps;
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "BROKER_CONNECTION_ATTEMPTED",
      executionRunId,
      details: { provider: "hyperliquid-testnet", apiUrl: String(this.transport.apiUrl) },
    });

    try {
      const meta = await this.info.meta();
      meta.universe.forEach((entry, index) => {
        this.assetIndexByCoin.set(entry.name, index);
        this.szDecimalsByCoin.set(entry.name, entry.szDecimals);
      });

      const state = await this.info.clearinghouseState({ user: this.accountAddress() });
      this.account = {
        cashBalance: Number(state.withdrawable),
        startingCashBalance: Number(state.marginSummary.accountValue),
      };
      this.connected = true;

      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "BROKER_CONNECTION_SUCCEEDED",
        executionRunId,
        details: {
          assetsAvailable: meta.universe.length,
          accountValue: state.marginSummary.accountValue,
          withdrawable: state.withdrawable,
        },
      });
    } catch (error) {
      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "BROKER_CONNECTION_FAILED",
        executionRunId,
        // Never the raw error object — it could (in principle) echo request details. Message only.
        details: { reason: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  /** Confirms `instrument` exists in the asset universe fetched by connect(). */
  hasInstrument(instrument: string): boolean {
    return this.assetIndexByCoin.has(instrument);
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

  /** Raw fills from the exchange, for the smoke test's own reporting — not part of the shared
   * PaperBroker interface, since LocalPaperBroker has no equivalent concept. */
  async getRawFills(): Promise<unknown[]> {
    return this.info.userFills({ user: this.accountAddress() });
  }

  /** Current mid price for `coin` — used by the smoke test to size and bound its test order.
   * Adapter-specific: a fixture-replay/paper broker has no live market to ask. */
  async getMidPrice(coin: string): Promise<number> {
    const mids = await this.info.allMids();
    const mid = mids[coin];
    if (mid === undefined) throw new Error(`No mid price available for "${coin}".`);
    return Number(mid);
  }

  async placeMarketOrder(order: OrderRequest): Promise<{ position: PaperPosition; orderId: string }> {
    this.requireConnected();
    if (order.side !== "BUY") {
      throw new Error(`HyperliquidTestnetBroker only supports opening long ("BUY") positions, got "${order.side}".`);
    }
    const assetId = this.requireAssetId(order.instrument);
    const szDecimals = this.requireSzDecimals(order.instrument);
    const cloid = this.nextCloid();

    await this.deps.auditTrail.record({
      timestamp: order.timestamp,
      eventType: "ORDER_SUBMITTED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      details: { side: order.side, quantity: order.quantity, price: order.price, cloid },
    });

    const response = await this.exchange.order({
      orders: [
        {
          a: assetId,
          b: true,
          p: formatPerpPrice(order.price, szDecimals),
          s: formatPerpSize(order.quantity, szDecimals),
          r: false,
          t: { limit: { tif: "FrontendMarket" } },
          c: cloid as `0x${string}`,
        },
      ],
      grouping: "na",
    });

    const status = response.response.data.statuses[0] as
      | OrderStatusFilled
      | OrderStatusResting
      | "waitingForFill"
      | "waitingForTrigger"
      | undefined;

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_ACKNOWLEDGED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { status: summarizeOrderStatus(status) },
    });

    if (!status || typeof status === "string") {
      // "waitingForFill"/"waitingForTrigger" apply to trigger (stop/TP) orders — this adapter
      // never submits one, so seeing either here would indicate the exchange behaved
      // unexpectedly, not a normal outcome to route through HyperliquidOrderRestingError.
      throw new Error(`Unexpected order status from Hyperliquid: ${String(status)}`);
    }
    if ("resting" in status) {
      throw new HyperliquidOrderRestingError(order.instrument, status.resting.oid);
    }

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_FILLED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { oid: status.filled.oid, avgPx: status.filled.avgPx, totalSz: status.filled.totalSz },
    });

    this.nextPositionSeq += 1;
    const position: PaperPosition = {
      positionId: `hl-position-${this.nextPositionSeq}`,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      side: order.side,
      quantity: Number(status.filled.totalSz),
      entryPrice: Number(status.filled.avgPx),
      entryTimestamp: order.timestamp,
      entryOrderId: String(status.filled.oid),
      takeProfitPercent: order.takeProfitPercent,
      stopLossPercent: order.stopLossPercent,
    };
    this.trackedPositions.set(order.instrument, position);
    await this.refreshAccountSnapshot();

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "POSITION_OPENED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { positionId: position.positionId, orderId: String(status.filled.oid), entryPrice: position.entryPrice },
    });

    return { position, orderId: String(status.filled.oid) };
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

    const assetId = this.requireAssetId(position.instrument);
    const szDecimals = this.requireSzDecimals(position.instrument);
    const cloid = this.nextCloid();

    const response = await this.exchange.order({
      orders: [
        {
          a: assetId,
          b: position.side !== "BUY", // opposite side to flatten
          p: formatPerpPrice(exitPrice, szDecimals),
          s: formatPerpSize(position.quantity, szDecimals),
          r: true, // reduce-only — this order can only close exposure, never open new exposure
          t: { limit: { tif: "FrontendMarket" } },
          c: cloid as `0x${string}`,
        },
      ],
      grouping: "na",
    });

    const status = response.response.data.statuses[0] as
      | OrderStatusFilled
      | OrderStatusResting
      | "waitingForFill"
      | "waitingForTrigger"
      | undefined;

    if (!status || typeof status === "string") {
      throw new Error(`Unexpected close-order status from Hyperliquid: ${String(status)}`);
    }
    if ("resting" in status) {
      throw new HyperliquidOrderRestingError(position.instrument, status.resting.oid);
    }

    const closeAvgPx = Number(status.filled.avgPx);
    const direction = position.side === "BUY" ? 1 : -1;
    const realisedPnl = (closeAvgPx - position.entryPrice) * position.quantity * direction;

    this.nextTradeSeq += 1;
    const trade: CompletedTrade = {
      tradeId: `hl-trade-${this.nextTradeSeq}`,
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
      exitPrice: closeAvgPx,
      exitTimestamp,
      exitOrderId: String(status.filled.oid),
      realisedPnl,
      closeReason,
    };

    this.trackedPositions.delete(position.instrument);
    this.completedTrades.push(trade);
    await this.refreshAccountSnapshot();

    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "POSITION_CLOSED",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { positionId: position.positionId, orderId: String(status.filled.oid), exitPrice: closeAvgPx },
    });
    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "REALISED_PNL",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { tradeId: trade.tradeId, realisedPnl },
    });

    return { trade, orderId: String(status.filled.oid) };
  }

  /** Cancels a resting order — used by the smoke test when placeMarketOrder/closePosition throw
   * HyperliquidOrderRestingError. Adapter-specific: LocalPaperBroker has no concept of a resting
   * order to cancel. */
  async cancelOrder(coin: string, oid: number): Promise<void> {
    this.requireConnected();
    const assetId = this.requireAssetId(coin);
    // cancel() throws ApiRequestError for any failed cancel before ever resolving — resolving at
    // all means every requested cancel in `cancels` succeeded (see the module doc comment above).
    const response = await this.exchange.cancel({ cancels: [{ a: assetId, o: oid }] });

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_CANCELLED",
      executionRunId: this.deps.executionRunId,
      instrument: coin,
      details: { oid, result: response.response.data.statuses[0] },
    });
  }

  private async refreshAccountSnapshot(): Promise<void> {
    const state = await this.info.clearinghouseState({ user: this.accountAddress() });
    this.account = { ...this.account, cashBalance: Number(state.withdrawable) };
  }

  private accountAddress(): `0x${string}` {
    return this.deps.config.accountAddress as `0x${string}`;
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("HyperliquidTestnetBroker.connect() must be called before use.");
  }

  private requireAssetId(coin: string): number {
    const assetId = this.assetIndexByCoin.get(coin);
    if (assetId === undefined) throw new Error(`Unknown Hyperliquid instrument "${coin}" — not in the asset universe.`);
    return assetId;
  }

  private requireSzDecimals(coin: string): number {
    const szDecimals = this.szDecimalsByCoin.get(coin);
    if (szDecimals === undefined) throw new Error(`Unknown Hyperliquid instrument "${coin}" — not in the asset universe.`);
    return szDecimals;
  }

  /** A 16-byte hex client-order-id, unique per call within this broker instance's lifetime —
   * both Trading Intelligence's own correlation id and (per Hyperliquid's own cloid semantics)
   * the mechanism that lets a resubmission of the same logical order be told apart from a
   * genuinely new one. */
  private nextCloid(): string {
    this.nextCloidSeq += 1;
    const runIdHex = Buffer.from(this.deps.executionRunId).toString("hex").padEnd(24, "0").slice(0, 24);
    const seqHex = this.nextCloidSeq.toString(16).padStart(8, "0");
    const cloid = `0x${runIdHex}${seqHex}`;
    if (this.submittedCloids.has(cloid)) {
      throw new Error(`Duplicate client order id ${cloid} — refusing to resubmit.`);
    }
    this.submittedCloids.add(cloid);
    return cloid;
  }
}

function summarizeOrderStatus(
  status: OrderStatusFilled | OrderStatusResting | "waitingForFill" | "waitingForTrigger" | undefined,
): string {
  if (!status) return "none";
  if (typeof status === "string") return status;
  if ("filled" in status) return "filled";
  if ("resting" in status) return "resting";
  return "unknown";
}
