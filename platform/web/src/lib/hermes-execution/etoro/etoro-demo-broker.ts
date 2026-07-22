import {
  EtoroClient,
  mapTimeframeToEtoroInterval,
  type EtoroDemoPortfolio,
  type EtoroInstrumentSearchResult,
  type EtoroPosition,
} from "./etoro-client";
import type { PaperBroker } from "../paper-broker";
import type { AuditTrail } from "../audit-trail";
import type { EtoroDemoConfig } from "../config";
import type { MarketTimeframe } from "../market-data/candle-validation";
import type { Account, Candle, CompletedTrade, OrderRequest, PaperPosition } from "../types";

const ORDER_CURRENCY = "usd"; // Every documented request-body example used "usd" — not per-instrument.

/** A resolved instrument — the numeric id eToro's execution/rates endpoints need, plus the display
 * details the smoke test prints before submitting anything. Keyed internally by the original
 * search term (e.g. "BTC"), mirroring Trading212DemoBroker's ticker-as-key convention. */
export interface EtoroResolvedInstrument {
  instrumentId: number;
  displayName: string;
  symbol: string;
}

export class EtoroNoInstrumentMatchError extends Error {
  constructor(public readonly searchTerm: string) {
    super(`No eToro instrument matched search term "${searchTerm}".`);
    this.name = "EtoroNoInstrumentMatchError";
  }
}

export class EtoroAmbiguousInstrumentError extends Error {
  constructor(
    public readonly searchTerm: string,
    public readonly candidates: EtoroInstrumentSearchResult[],
  ) {
    super(
      `Search term "${searchTerm}" matched ${candidates.length} eToro instruments — ambiguous. ` +
        `Candidates: ${candidates.map((c) => `${c.symbolFull} (id=${c.instrumentID}, typeID=${c.instrumentTypeID})`).join(", ")}`,
    );
    this.name = "EtoroAmbiguousInstrumentError";
  }
}

/** Thrown when eToro's rates endpoint returns no usable bid/ask for a resolved instrument.
 * `reason: "absent"` means the requested instrument id wasn't in the response's `rates` array at
 * all (confirmed live: an unrecognised id yields `{"rates":[]}`, HTTP 200 — not an error, not a
 * null entry). `reason: "unpriced"` means a rate entry for the id DID exist but had no bid/ask —
 * not observed live for any instrument tried, kept as a distinct, defensive case regardless (e.g.
 * a suspended/quoteless instrument). eToro's API documents no distinct "market closed" flag we
 * could confirm (unlike Trading212's working-schedule endpoint) — treating either case as
 * "possibly market closed" downstream is a best-effort interpretation, not a confirmed diagnosis.
 * See docs/etoro-demo-adapter-phase-1.md's known-limitations section. */
export class EtoroRateUnavailableError extends Error {
  constructor(
    public readonly instrumentId: number,
    public readonly reason: "absent" | "unpriced",
  ) {
    super(
      reason === "absent"
        ? `eToro's rates response did not include instrument ${instrumentId} at all.`
        : `eToro returned a rate entry for instrument ${instrumentId} but it had no usable bid/ask.`,
    );
    this.name = "EtoroRateUnavailableError";
  }
}

/**
 * Phase 2A — Real Historical Candles for Live Market Data. Thrown when eToro's candle-history
 * endpoint returns no usable candle block for the resolved instrument. `reason: "absent"` means no
 * block in the response's outer `candles` array matched the requested instrument at all.
 * `reason: "empty"` means a block WAS matched but its own nested `candles` array had no entries.
 * Mirrors EtoroRateUnavailableError's own "absent vs. present-but-unusable" distinction. */
export class EtoroCandleHistoryUnavailableError extends Error {
  constructor(
    public readonly instrumentId: number,
    public readonly reason: "absent" | "empty",
  ) {
    super(
      reason === "absent"
        ? `eToro's candle-history response did not include instrument ${instrumentId} at all.`
        : `eToro returned a candle-history entry for instrument ${instrumentId} but it contained no candles.`,
    );
    this.name = "EtoroCandleHistoryUnavailableError";
  }
}

/** Thrown when an order was accepted but this adapter cannot reliably identify which portfolio
 * position it produced.
 *
 * - `"no-identifier"`: eToro's response contained none of orderId/positionId/token/requestToken —
 *   a documentation/response-shape limitation, not evidence the trade failed.
 * - `"not-found"`: a positionId WAS returned directly but no matching position exists in the
 *   re-fetched portfolio — a more concerning, concrete mismatch. Not observed live (a real market
 *   order's response never includes positionId — see EtoroOrderExecutionResult's doc comment) but
 *   kept for any order type that might return one directly.
 * - `"pending"`: reconcilePositionByOrderId's poll window elapsed while the order was still
 *   sitting in the portfolio's pending `orders` list — not yet a position, but not lost either.
 * - `"timeout"`: reconcilePositionByOrderId's poll window elapsed and the order appeared in
 *   neither `positions` nor `orders` — the most concerning case, genuinely unaccounted for.
 *
 * The smoke test maps these to different outcomes (INCONCLUSIVE_API_LIMITATION / FAILED /
 * CLEANUP_REQUIRED / CLEANUP_REQUIRED respectively). */
export class EtoroReconciliationError extends Error {
  constructor(
    public readonly reason: "no-identifier" | "not-found" | "pending" | "timeout",
    public readonly detail: string,
  ) {
    super(detail);
    this.name = "EtoroReconciliationError";
  }
}

/** Thrown when a close was submitted but this adapter cannot confirm the position is actually
 * gone — the smoke test's cue to report CLEANUP_REQUIRED rather than guessing at success. */
export class EtoroCleanupRequiredError extends Error {
  constructor(
    public readonly positionId: number,
    detail: string,
  ) {
    super(detail);
    this.name = "EtoroCleanupRequiredError";
  }
}

export interface EtoroBrokerDeps {
  config: EtoroDemoConfig;
  auditTrail: AuditTrail;
  executionRunId: string;
}

function assertValidAmount(amount: number, context: string): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Refusing to submit an eToro order for ${context}: amount (${amount}) is not a valid positive finite number.`);
  }
}

// Bounded order-reconciliation polling — within this task's suggested 1-2s interval / 20-30s total
// wait. No existing smoke-test convention makes these configurable (Trading212's own poll
// constants are likewise hard-coded), so kept simple here too, not env-driven.
const RECONCILE_POLL_INTERVAL_MS = 1_500;
const RECONCILE_MAX_WAIT_MS = 25_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Confirmed live (GET /api/v1/market-data/instruments): every native crypto instrument (Bitcoin,
// Bitcoin Cash, Bitcoin/Euro, Ethereum/Bitcoin, ...) has instrumentTypeID 10 on exchangeID 8
// ("Digital Currency"), while a same-named derivative/ETF/equity (a Bitcoin future, an iShares
// Bitcoin Trust, a bitcoin-mining stock) uses a different instrumentTypeID/exchangeID. Used only to
// disambiguate an otherwise-tied match set — see resolveInstrument/matchInstruments below.
const CRYPTO_INSTRUMENT_TYPE_ID = 10;

/** Resilient, tiered matching over the full instrument list (this endpoint has no working
 * server-side text filter — see etoro-client.ts's searchInstruments doc comment). Tries the
 * strictest interpretation first; a looser tier is only consulted if a stricter one found nothing
 * at all, never as a supplement to it. */
function matchInstruments(searchTerm: string, all: EtoroInstrumentSearchResult[]): EtoroInstrumentSearchResult[] {
  const lowerTerm = searchTerm.toLowerCase();

  const exactSymbol = all.filter((i) => i.symbolFull === searchTerm);
  if (exactSymbol.length > 0) return exactSymbol;

  const exactDisplayName = all.filter((i) => i.instrumentDisplayName === searchTerm);
  if (exactDisplayName.length > 0) return exactDisplayName;

  const looseSymbol = all.filter((i) => i.symbolFull.toLowerCase() === lowerTerm);
  if (looseSymbol.length > 0) return looseSymbol;

  return all.filter((i) => i.instrumentDisplayName.toLowerCase() === lowerTerm);
}

/**
 * Behind the same PaperBroker interface LocalPaperBroker, HyperliquidTestnetBroker, and
 * Trading212DemoBroker implement — see docs/etoro-demo-adapter-phase-1.md for the full design and
 * its documentation/live-response discrepancies.
 *
 * Unlike the other two external adapters, eToro trades CFD notional "amount" (a currency value),
 * not a share/unit count — `OrderRequest.quantity`/`PaperPosition.quantity` are reused to carry
 * this amount (consistent field, different meaning), and realised P/L is computed as a percentage
 * return on that notional (see closePosition), not price-delta-times-units — the correct CFD
 * formula, not a copy of the equity/perp formula the other two adapters use.
 *
 * Only positions opened through this broker instance are tracked — this is a connectivity/smoke-
 * test adapter, not a general-purpose account manager, same as every other broker here.
 */
export class EtoroDemoBroker implements PaperBroker {
  private readonly client: EtoroClient;
  private readonly resolvedInstruments = new Map<string, EtoroResolvedInstrument>();
  private readonly trackedPositions = new Map<string, PaperPosition>(); // keyed by internal positionId
  private readonly etoroPositionIdByInternalId = new Map<string, number>();

  private account: Account = { cashBalance: 0, startingCashBalance: 0 };
  private completedTrades: CompletedTrade[] = [];
  private nextPositionSeq = 0;
  private nextTradeSeq = 0;
  private connected = false;

  constructor(private readonly deps: EtoroBrokerDeps) {
    const { config } = deps;
    if (config.env !== "demo") {
      throw new Error("EtoroDemoBroker constructed without ETORO_ENV=demo.");
    }
    if (!config.apiKey || !config.userKey) {
      throw new Error("EtoroDemoBroker requires both ETORO_API_KEY and ETORO_USER_KEY to be set.");
    }
    this.client = new EtoroClient(config.apiKey, config.userKey, config.httpTimeoutMs);
  }

  /** Verifies credentials via a lightweight demo-portfolio read (no separate "whoami" endpoint is
   * documented) and captures an initial snapshot. Must be called once before any other method. */
  async connect(): Promise<void> {
    const { auditTrail, executionRunId } = this.deps;
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "BROKER_CONNECTION_ATTEMPTED",
      executionRunId,
      details: { provider: "etoro-demo" },
    });

    try {
      const portfolio = await this.client.getDemoPortfolio();
      // Confirmed live: everything is nested under `clientPortfolio` — `credit` is the demo
      // account's real virtual balance (was previously never read at all, always left at the
      // {cashBalance:0, startingCashBalance:0} default).
      this.account = {
        cashBalance: portfolio.clientPortfolio.credit,
        startingCashBalance: portfolio.clientPortfolio.credit,
      };
      this.connected = true;

      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "BROKER_CONNECTION_SUCCEEDED",
        executionRunId,
        details: {
          openPositions: portfolio.clientPortfolio.positions.length,
          pendingOrders: portfolio.clientPortfolio.orders.length,
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

  /** Resolves a human-readable search term (e.g. "BTC") through eToro's own instrument-metadata
   * endpoint — never a hard-coded instrumentId. This endpoint returns its entire ~16,000-
   * instrument universe regardless of query params (confirmed live — no working server-side text
   * filter exists), so matching happens client-side via `matchInstruments` (exact symbol > exact
   * display name > case-insensitive symbol > case-insensitive display name). Throws on no match;
   * on an ambiguous match, narrows to the crypto instrument if exactly one candidate is one,
   * otherwise still throws. The resolved instrument is cached under `searchTerm` as this adapter's
   * internal instrument identifier, used by placeMarketOrder/getRate below. */
  async resolveInstrument(searchTerm: string): Promise<EtoroResolvedInstrument> {
    this.requireConnected();
    const response = await this.client.searchInstruments(searchTerm);
    const all = response.instrumentDisplayDatas ?? [];

    let candidates = matchInstruments(searchTerm, all);
    if (candidates.length === 0) throw new EtoroNoInstrumentMatchError(searchTerm);

    if (candidates.length > 1) {
      // e.g. searching "Bitcoin" would otherwise also match "Bitcoin Group SE" (a stock) or
      // "Bitcoin Future CME" (a future) alongside the real spot asset — prefer the exact crypto
      // instrument over a same-named derivative/ETF/equity when it uniquely disambiguates.
      const cryptoOnly = candidates.filter((c) => c.instrumentTypeID === CRYPTO_INSTRUMENT_TYPE_ID);
      if (cryptoOnly.length !== 1) throw new EtoroAmbiguousInstrumentError(searchTerm, candidates);
      candidates = cryptoOnly;
    }

    const match = candidates[0]!;
    const resolved: EtoroResolvedInstrument = {
      instrumentId: match.instrumentID,
      displayName: match.instrumentDisplayName,
      symbol: match.symbolFull,
    };
    this.resolvedInstruments.set(searchTerm, resolved);
    return resolved;
  }

  /** Current bid/ask for a previously resolved instrument. Matches the rates response's own
   * `instrumentID` (capital ID — confirmed live; the lowercase `instrumentId` this used to match
   * against never matched anything real). Throws EtoroRateUnavailableError, distinguishing an
   * instrument genuinely absent from the response from one present but lacking bid/ask (see that
   * class's doc comment). HTTP/API failures never reach here as this error — EtoroClient's
   * transport layer throws EtoroApiError for those before this method ever sees a response. */
  async getRate(internalInstrument: string): Promise<{ bid: number; ask: number }> {
    const resolved = this.requireResolvedInstrument(internalInstrument);
    const response = await this.client.getRates([resolved.instrumentId]);
    const rate = (response.rates ?? []).find((r) => r.instrumentID === resolved.instrumentId);

    if (!rate) throw new EtoroRateUnavailableError(resolved.instrumentId, "absent");
    if (rate.bid === undefined || rate.ask === undefined) {
      throw new EtoroRateUnavailableError(resolved.instrumentId, "unpriced");
    }
    return { bid: rate.bid, ask: rate.ask };
  }

  /**
   * Phase 2A — Real Historical Candles for Live Market Data. Historical OHLCV candles for a
   * previously resolved instrument — translates `timeframe` into eToro's own interval enum
   * (mapTimeframeToEtoroInterval) exactly as this method's sibling, getRate(), already translates
   * a human-readable symbol into eToro's instrumentId via resolveInstrument()/
   * requireResolvedInstrument(). Returns plain Candle[] (chronological, oldest-first) — this
   * method only fetches and translates; it deliberately does not validate the result (no NaN/
   * staleness/gap checks) — that is LiveMarketDataProvider's job (candle-validation.ts), the same
   * division of responsibility getRate() already has with LiveMarketDataProvider's own
   * isValidPrice/inverted-rate checks.
   *
   * The endpoint's own response nests candles inside a block keyed by (a differently-cased)
   * `instrumentId` — since this call is already scoped to one instrument via the URL's own
   * `{instrumentId}` path segment, an exact id match is preferred, but if the response contains
   * exactly one block and its id doesn't match (a plausible outcome given this DTO is
   * documentation-only and unconfirmed live — see etoro-client.ts's own EtoroCandleInterval doc
   * comment), that single block is used rather than treated as "absent" outright.
   */
  async getHistoricalCandles(internalInstrument: string, timeframe: MarketTimeframe, count: number): Promise<Candle[]> {
    const resolved = this.requireResolvedInstrument(internalInstrument);
    const interval = mapTimeframeToEtoroInterval(timeframe);
    const response = await this.client.getHistoricalCandles(resolved.instrumentId, interval, count, "asc");

    const blocks = response.candles ?? [];
    const block =
      blocks.find((b) => b.instrumentId === resolved.instrumentId) ?? (blocks.length === 1 ? blocks[0] : undefined);
    if (!block) throw new EtoroCandleHistoryUnavailableError(resolved.instrumentId, "absent");

    const entries = block.candles ?? [];
    if (entries.length === 0) throw new EtoroCandleHistoryUnavailableError(resolved.instrumentId, "empty");

    return entries.map((entry) => ({
      symbol: internalInstrument,
      timestamp: entry.fromDate,
      open: entry.open,
      high: entry.high,
      low: entry.low,
      close: entry.close,
      // Phase 2A follow-up — Volume Nullability. eToro's documented schema declares this
      // required/numeric, but a real live response can return null (confirmed via
      // market:diagnostics) or, now that one of the DTO's own declared-required fields has proven
      // unreliable, conceivably omit the key entirely — both normalized to undefined (this
      // pipeline's own "volume unknown" representation), never fabricated as 0. See
      // EtoroCandleEntry's own doc comment.
      volume: entry.volume === null || entry.volume === undefined ? undefined : entry.volume,
    }));
  }

  hasResolvedInstrument(internalInstrument: string): boolean {
    return this.resolvedInstruments.has(internalInstrument);
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

  /** The account's full demo portfolio straight from eToro — for the smoke test's own reporting
   * and its own "did my position actually appear" confirmation step. */
  async getRawPortfolio(): Promise<EtoroDemoPortfolio> {
    return this.client.getDemoPortfolio();
  }

  async placeMarketOrder(order: OrderRequest): Promise<{ position: PaperPosition; orderId: string }> {
    this.requireConnected();
    if (order.side !== "BUY") {
      throw new Error(`EtoroDemoBroker.placeMarketOrder only opens long ("BUY") positions, got "${order.side}".`);
    }
    assertValidAmount(order.quantity, order.instrument);
    const resolved = this.requireResolvedInstrument(order.instrument);

    await this.deps.auditTrail.record({
      timestamp: order.timestamp,
      eventType: "ORDER_SUBMITTED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      details: { instrumentId: resolved.instrumentId, amount: order.quantity, orderCurrency: ORDER_CURRENCY },
    });

    const execResult = await this.client.placeDemoMarketOrder({
      instrumentId: resolved.instrumentId,
      isBuy: true,
      amount: order.quantity,
      orderCurrency: ORDER_CURRENCY,
    });

    const identifier = execResult.positionId ?? execResult.orderId ?? execResult.token ?? execResult.requestToken;
    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "ORDER_ACKNOWLEDGED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      // orderId is a plain reference number, safe to record; the token's VALUE is not confirmed
      // non-secret, so only whether one was received is recorded, never the value itself.
      details: {
        identifier: identifier ?? null,
        orderId: execResult.orderId ?? null,
        tokenReceived: execResult.token !== undefined,
      },
    });

    if (identifier === undefined) {
      throw new EtoroReconciliationError(
        "no-identifier",
        `eToro's order response contained none of orderId/positionId/token/requestToken for ${order.instrument} — cannot identify the resulting position.`,
      );
    }

    let matched: EtoroPosition;
    if (execResult.positionId !== undefined) {
      // Not observed live for a plain market order (the real response is only { orderId, token }
      // — see reconcilePositionByOrderId below), but kept in case some other order type returns
      // positionId directly, in which case there's nothing to poll for.
      const portfolio = await this.client.getDemoPortfolio();
      const direct = portfolio.clientPortfolio.positions.find((p) => p.positionID === execResult.positionId);
      if (!direct) {
        throw new EtoroReconciliationError(
          "not-found",
          `eToro returned positionId=${execResult.positionId} for ${order.instrument}, but no matching position exists in the re-fetched demo portfolio.`,
        );
      }
      matched = direct;
    } else if (execResult.orderId !== undefined) {
      matched = await this.reconcilePositionByOrderId(execResult.orderId, order.instrument);
    } else {
      // Only a bare token/requestToken came back, no orderId or positionId — no confirmed field
      // links those identifiers back to a specific position, so instrument-only matching
      // (forbidden by this phase's requirements) is the only fallback, and it's refused instead.
      throw new EtoroReconciliationError(
        "no-identifier",
        `eToro returned only a token for ${order.instrument}, with neither an orderId nor a positionId to reconcile against a portfolio position.`,
      );
    }

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "POSITION_CONFIRMED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { etoroPositionId: matched.positionID },
    });

    this.nextPositionSeq += 1;
    const positionId = `etoro-position-${this.nextPositionSeq}`;
    const entryPrice = matched.openRate ?? order.price;
    const position: PaperPosition = {
      positionId,
      strategyId: order.strategyId,
      strategyVersion: order.strategyVersion,
      sourceType: order.sourceType,
      instrument: order.instrument,
      side: order.side,
      quantity: matched.amount ?? order.quantity,
      entryPrice,
      entryTimestamp: order.timestamp,
      entryOrderId: String(identifier),
      takeProfitPercent: order.takeProfitPercent,
      stopLossPercent: order.stopLossPercent,
    };
    this.trackedPositions.set(positionId, position);
    this.etoroPositionIdByInternalId.set(positionId, matched.positionID);

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "POSITION_OPENED",
      executionRunId: this.deps.executionRunId,
      strategyId: order.strategyId,
      instrument: order.instrument,
      details: { positionId, orderId: String(identifier), entryPrice },
    });

    return { position, orderId: String(identifier) };
  }

  /** `exitPrice` is caller-supplied (same contract shape as LocalPaperBroker) — eToro's close
   * confirmation is a bare token, no fill price, so the smoke test fetches a current rate itself
   * (the same way it does before opening) and passes it in. */
  async closePosition(
    positionId: string,
    exitPrice: number,
    exitTimestamp: string,
    closeReason: string,
  ): Promise<{ trade: CompletedTrade; orderId: string }> {
    this.requireConnected();
    const position = this.trackedPositions.get(positionId);
    const etoroPositionId = this.etoroPositionIdByInternalId.get(positionId);
    if (!position || etoroPositionId === undefined) {
      throw new Error(`No open position ${positionId} — it may have already been closed.`);
    }
    assertValidAmount(position.quantity, position.instrument);

    const resolved = this.requireResolvedInstrument(position.instrument);

    await this.deps.auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "POSITION_CLOSE_SUBMITTED",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { positionId, etoroPositionId },
    });

    // Any failure here (the close endpoint itself) propagates immediately, before verification
    // ever starts — structurally distinct from a verification-time portfolio failure below.
    await this.client.closeDemoPosition(resolved.instrumentId, etoroPositionId);

    // Confirmed live: a position that "still appears open" on the very first read right after
    // closeDemoPosition() resolves can disappear a few seconds later — the same eventual-
    // consistency behaviour already observed for order reconciliation. Bounded polling, not a
    // single immediate check, avoids misreporting a genuinely successful close as CLEANUP_REQUIRED.
    await this.verifyPositionClosed(etoroPositionId, position.instrument);

    // CFD notional P/L: `quantity` here is invested notional (eToro's "amount"), not a unit count,
    // so realised P/L is the notional's percentage return, NOT price-delta-times-units (the
    // formula Trading212/Hyperliquid use for their share/unit-count-based positions).
    const direction = position.side === "BUY" ? 1 : -1;
    const percentReturn = ((exitPrice - position.entryPrice) / position.entryPrice) * direction;
    const realisedPnl = position.quantity * percentReturn;

    this.nextTradeSeq += 1;
    const trade: CompletedTrade = {
      tradeId: `etoro-trade-${this.nextTradeSeq}`,
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
      exitOrderId: `etoro-close-${etoroPositionId}`,
      realisedPnl,
      closeReason,
    };

    this.trackedPositions.delete(positionId);
    this.etoroPositionIdByInternalId.delete(positionId);
    this.completedTrades.push(trade);

    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "POSITION_CLOSED",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { positionId, etoroPositionId, exitPrice },
    });
    await this.deps.auditTrail.record({
      timestamp: exitTimestamp,
      eventType: "REALISED_PNL",
      executionRunId: this.deps.executionRunId,
      strategyId: position.strategyId,
      instrument: position.instrument,
      details: { tradeId: trade.tradeId, realisedPnl },
    });

    return { trade, orderId: trade.exitOrderId };
  }

  /**
   * Polls the demo portfolio for a position whose own `orderID` matches `orderId` — the only
   * reliable link back to a specific position when the order-execution response itself has no
   * `positionId` (confirmed live: it never does for a plain market order). Bounded: at most one
   * request every RECONCILE_POLL_INTERVAL_MS, for at most RECONCILE_MAX_WAIT_MS total — never an
   * infinite loop. Any error fetching the portfolio propagates immediately as a genuine API
   * failure; it is never swallowed or silently retried.
   */
  private async reconcilePositionByOrderId(orderId: number, instrument: string): Promise<EtoroPosition> {
    const { auditTrail, executionRunId } = this.deps;
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "RECONCILIATION_STARTED",
      executionRunId,
      instrument,
      details: { orderId },
    });

    const deadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    let attempts = 0;
    let orderStillPending = false;

    while (Date.now() < deadline) {
      attempts += 1;
      const portfolio = await this.client.getDemoPortfolio();
      const matched = portfolio.clientPortfolio.positions.find((p) => p.orderID === orderId);
      if (matched) return matched;

      orderStillPending = portfolio.clientPortfolio.orders.some((o) => o.orderID === orderId);
      await sleep(RECONCILE_POLL_INTERVAL_MS);
    }

    if (orderStillPending) {
      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "RECONCILIATION_PENDING",
        executionRunId,
        instrument,
        details: { orderId, attempts },
      });
      throw new EtoroReconciliationError(
        "pending",
        `eToro order ${orderId} on ${instrument} is still pending after ${attempts} reconciliation attempts (~${RECONCILE_MAX_WAIT_MS}ms) — it has not yet become a position.`,
      );
    }

    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "RECONCILIATION_TIMED_OUT",
      executionRunId,
      instrument,
      details: { orderId, attempts },
    });
    throw new EtoroReconciliationError(
      "timeout",
      `Reconciliation for eToro order ${orderId} on ${instrument} timed out after ${attempts} attempts (~${RECONCILE_MAX_WAIT_MS}ms) — neither a matching position nor a pending order was found.`,
    );
  }

  /**
   * Polls the demo portfolio until `etoroPositionId` is no longer present in
   * clientPortfolio.positions — see closePosition's call site for why a single immediate check
   * isn't enough. Bounded exactly like reconcilePositionByOrderId (same constants): at most one
   * request every RECONCILE_POLL_INTERVAL_MS, for at most RECONCILE_MAX_WAIT_MS total — never an
   * infinite loop. Any error fetching the portfolio propagates immediately as a genuine API
   * failure, never swallowed or retried. POSITION_CLOSED (recorded by the caller once this
   * returns) already serves as the "close verified" event — not duplicated here.
   */
  private async verifyPositionClosed(etoroPositionId: number, instrument: string): Promise<void> {
    const { auditTrail, executionRunId } = this.deps;
    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "CLOSE_VERIFICATION_STARTED",
      executionRunId,
      instrument,
      details: { etoroPositionId },
    });

    const deadline = Date.now() + RECONCILE_MAX_WAIT_MS;
    let attempts = 0;

    while (Date.now() < deadline) {
      attempts += 1;
      const portfolio = await this.client.getDemoPortfolio();
      const stillOpen = portfolio.clientPortfolio.positions.some((p) => p.positionID === etoroPositionId);
      if (!stillOpen) return;

      await auditTrail.record({
        timestamp: new Date().toISOString(),
        eventType: "CLOSE_VERIFICATION_PENDING",
        executionRunId,
        instrument,
        details: { etoroPositionId, attempts },
      });
      await sleep(RECONCILE_POLL_INTERVAL_MS);
    }

    await auditTrail.record({
      timestamp: new Date().toISOString(),
      eventType: "CLOSE_VERIFICATION_TIMED_OUT",
      executionRunId,
      instrument,
      details: { etoroPositionId, attempts },
    });
    throw new EtoroCleanupRequiredError(
      etoroPositionId,
      `eToro position ${etoroPositionId} (${instrument}) still appears open after ${attempts} verification attempts (~${RECONCILE_MAX_WAIT_MS}ms) — manual follow-up required.`,
    );
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("EtoroDemoBroker.connect() must be called before use.");
  }

  private requireResolvedInstrument(internalInstrument: string): EtoroResolvedInstrument {
    const resolved = this.resolvedInstruments.get(internalInstrument);
    if (!resolved) {
      throw new Error(
        `"${internalInstrument}" was never resolved through resolveInstrument() — refusing to submit an order against unresolved market data.`,
      );
    }
    return resolved;
  }
}
