import "server-only";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import { hasInstrumentResolution } from "@/lib/hermes-execution/runtime/position-reconciliation";
import { calculateUnrealizedPnl } from "@/lib/hermes-execution/trade-lifecycle/calculations";
import { logger } from "@/lib/logger/logger";

// Hermes Integration API v1. Reuses the existing broker abstraction (BrokerFactory + the PaperBroker
// interface every adapter already implements) exactly as market-decide.ts/market-runtime.ts do —
// this file adds no new broker/trading logic, only a request-scoped connection plus a mapping into
// generic, non-broker-specific DTOs.
//
// Deliberately uses a throwaway, in-memory AuditTrail — NEVER the shared, disk-persisted
// JsonFileAuditTrail the standalone `market:runtime` process writes to. JsonFileAuditTrail.persist()
// is a full-file overwrite, not an atomic append; two independent Node processes read-modify-
// writing the same JSON file is a genuine corruption risk this API must never introduce. This
// endpoint only ever needs a broker connection's own live response, never to contribute an entry to
// that file — see docs/hermes-integration-api.md's "Architecture" section.
//
// Missing-financial-data fix. Unrealised P/L is now computed HERE, once, from broker-ground-truth
// data only — never from a locally-tracked lifecycle record's own quantity/sizingMode (which, for
// eToro, represents the NOTIONAL/invested amount, not the actual leveraged unit exposure a correct
// P/L calculation needs — see EtoroPosition's own `units` field, confirmed present on eToro's real
// position response but previously not modelled by this file's own narrower RawPortfolioBroker
// type). Both /api/hermes/portfolio and /api/hermes/positions call this SAME function, so both see
// one coherent snapshot (one broker connection, one set of live rates, one timestamp) rather than
// two independently-fetched, potentially-mismatched prices.

export interface HermesPositionDto {
  /** eToro exposes no human-readable symbol on a raw position (only a numeric instrumentID). Main
   * Dashboard Hermes/eToro fix: mapped back to the app's own configured instrument symbol (e.g.
   * "BTC") via resolveInstrumentIdMap() below whenever the broker supports instrument resolution
   * and the id is a KNOWN, resolved one — never a guessed mapping. Falls back to the raw numeric id
   * as a string only when genuinely unresolvable (an unrecognised instrument, or a broker with no
   * resolution capability at all) — see this module's own EtoroDemoBroker branch below. */
  instrument: string;
  /** Instrument-resolution defect fix. The broker's own raw numeric instrument identifier (eToro's
   * `instrumentID`) — preserved alongside the friendly `instrument` symbol above so live pricing
   * can be cross-checked against it (see priceOpenPositions()'s own mismatch guard) even though the
   * broker's own quoting methods are keyed by a resolved SYMBOL/search-term, not this raw id
   * directly. Null for a broker with no separate raw-id concept (the generic PaperBroker fallback
   * branch below, where `instrument` already IS the broker-native identifier). */
  brokerInstrumentId: number | null;
  side: "BUY" | "SELL" | "unknown";
  /** The notional/invested amount in the account's own currency (eToro's own "amount" field, or a
   * non-eToro broker's own quantity where that IS the true unit count) — the pre-existing "display
   * value" concept used for `investedValue` aggregation. NEVER used for P/L math — see `units`. */
  quantity: number | null;
  /** Missing-financial-data fix. The actual quantity of the underlying instrument this position
   * represents (eToro's own "units" field) — the CORRECT figure for unrealised P/L math, since it
   * already reflects any leverage (unlike `quantity`/"amount" above, which is the pre-leverage
   * invested/margin amount). For a broker without a raw ground-truth read (the fallback branch
   * below), `quantity` already IS the true unit count, so `units` simply equals it there. Null only
   * when genuinely unknown. */
  units: number | null;
  entryPrice: number | null;
  /** Missing-financial-data fix. A genuinely fetched live price for this position's own instrument
   * — the bid for a BUY/long position, the ask for a SELL/short position (the side that would
   * actually be realised by closing right now — matches market-decision-runner.ts's own
   * closing-price convention). Null when a live price could not be fetched/mapped for this specific
   * position — see `pricingSource`; never fabricated or carried over from a stale read. */
  currentPrice: number | null;
  /** calculateUnrealizedPnl("UNITS", side, entryPrice, currentPrice, units) — the exact formula this
   * codebase already trusts for a CLOSED trade's own realised P/L, applied here with the live
   * current price standing in for an eventual exit price. Null whenever entryPrice/units/
   * currentPrice aren't ALL available for this position — never partially estimated. */
  unrealisedPnl: number | null;
  /** When `currentPrice`/`unrealisedPnl` were computed — always the same instant across every
   * position in one snapshot (one batch of live rate fetches, not one per position over time). */
  pricingTimestamp: string | null;
  /** "broker" — a genuine live rate fetch from the connected broker succeeded. "unavailable" — it
   * did not (fetch failure, unmapped instrument, or a broker with no rate-fetching capability at
   * all) — never conflated with a successful zero-valued fetch. */
  pricingSource: "broker" | "unavailable";
  /** Instrument-resolution defect fix. Explicit diagnostic provenance for WHY this specific
   * position's pricing is unavailable — names the requested display symbol, the broker instrument
   * id (when known), and the underlying resolution/quote failure, so an operator never has to
   * cross-reference logs to understand a single "Unavailable" figure. Null exactly when
   * `pricingSource === "broker"`. */
  pricingFailureReason: string | null;
  openedAt: string | null;
  provider: string;
  accountMode: string;
  /** The broker's own durable position identifier — safe for internal dashboard display (never a
   * credential, never a broker/account secret). Null when the broker doesn't expose one. */
  brokerPositionId: string | null;
}

interface HermesBrokerSnapshotOk {
  ok: true;
  provider: string;
  accountMode: string;
  cash: number;
  positions: HermesPositionDto[];
  /**
   * True only when positions were read via a broker-specific *live ground-truth* call (eToro's
   * `getRawPortfolio()`, which queries eToro directly) rather than `PaperBroker.getOpenPositions()`
   * — which, for EtoroDemoBroker specifically, reflects only orders THIS freshly-constructed broker
   * instance itself placed (always empty for a brand-new instance), not the real remote account
   * state. See the `hasRawPortfolio` branch below.
   */
  positionsAreLiveGroundTruth: boolean;
  /** Missing-financial-data fix. True when EVERY open position in `positions` above was
   * successfully priced (pricingSource: "broker" on all of them) — the only condition under which
   * summing `positions[].unrealisedPnl` is a genuinely complete total, never a partial one silently
   * presented as whole. True (vacuously) when there are no open positions at all. */
  unrealisedPnlComplete: boolean;
  /** Non-null exactly when `unrealisedPnlComplete` is false — names which instrument(s) could not
   * be priced, so a caller/reader can see WHY the total is incomplete, never just that it is. */
  unrealisedPnlUnavailableReason: string | null;
}

interface HermesBrokerSnapshotFailure {
  ok: false;
  message: string;
}

export type HermesBrokerSnapshot = HermesBrokerSnapshotOk | HermesBrokerSnapshotFailure;

/** Duck-typed — the same "depend on the narrowest shape needed" convention already used elsewhere
 * in this codebase (runtime-dependency-factory.ts's SymbolResolvableBroker/RateSourceBroker). Only
 * EtoroDemoBroker implements this today; this module never imports that class directly. */
interface RawPortfolioBroker {
  getRawPortfolio(): Promise<{
    clientPortfolio: {
      positions: Array<{
        instrumentID: number;
        isBuy?: boolean;
        amount?: number;
        /** Missing-financial-data fix. Confirmed present on eToro's real position response
         * (EtoroPosition's own doc comment) — simply not previously modelled by this narrower,
         * hand-picked type. The actual underlying-asset quantity this position represents, already
         * reflecting any leverage — see HermesPositionDto.units's own doc comment for why this
         * (never `amount`) is the correct figure for P/L math. */
        units?: number;
        openRate?: number;
        openDateTime?: string;
        positionID?: number;
      }>;
      credit: number;
    };
  }>;
}

function hasRawPortfolio(broker: PaperBroker): broker is PaperBroker & RawPortfolioBroker {
  return typeof (broker as Partial<RawPortfolioBroker>).getRawPortfolio === "function";
}

/** Missing-financial-data fix. The minimal live-quote capability this module needs — deliberately
 * the same narrow shape live-market-data-provider.ts's own RateSource already declares (structurally
 * compatible, EtoroDemoBroker.getRate satisfies both with no adaptation), declared locally rather
 * than imported to keep this file's own "narrowest shape needed, no concrete broker/provider import"
 * convention consistent with hasRawPortfolio/hasInstrumentResolution above. */
interface RateQuotingBroker {
  getRate(instrument: string): Promise<{ bid: number; ask: number }>;
}

function hasRateQuoting(broker: unknown): broker is RateQuotingBroker {
  return typeof (broker as Partial<RateQuotingBroker>).getRate === "function";
}

// Main Dashboard Hermes/eToro fix — instrument-ID-to-symbol mapping. eToro's own instrument search
// returns its ENTIRE ~16,000-instrument universe regardless of the search term (confirmed live —
// see etoro-client.ts's own EtoroInstrumentSearchResponse doc comment), so resolveInstrument() is
// not cheap to call on every single portfolio/positions poll. Real-world instrument identities
// never change, so this is cached at MODULE scope (this process's whole lifetime, across every
// getBrokerSnapshot() call and every freshly-constructed broker instance — getBrokerSnapshot()
// itself constructs a new, throwaway broker per call, so a per-broker-instance cache would never
// actually persist) — resolved lazily, once, the first time a raw position's instrument id needs
// mapping. Only entries that resolved successfully are cached; an instrument that failed to
// resolve is simply retried on the next call, never permanently remembered as "unknown."
let instrumentIdToSymbolCache: Map<number, string> | undefined;

async function resolveInstrumentIdMap(
  broker: PaperBroker,
  instrumentUniverse: readonly string[],
): Promise<Map<number, string>> {
  if (instrumentIdToSymbolCache) return instrumentIdToSymbolCache;
  if (!hasInstrumentResolution(broker)) return new Map();

  const resolved = new Map<number, string>();
  for (const instrument of instrumentUniverse) {
    try {
      const { instrumentId } = await broker.resolveInstrument(instrument);
      resolved.set(instrumentId, instrument);
    } catch (error) {
      logger.warn("Hermes Integration API could not resolve one configured instrument's id — its raw positions will show a numeric id instead", {
        component: "hermes-integration-broker-snapshot",
        instrument,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  instrumentIdToSymbolCache = resolved;
  return resolved;
}

/** Test-only escape hatch — mirrors resetHermesExecutionConfigCacheForTests(). */
export function resetInstrumentIdToSymbolCacheForTests(): void {
  instrumentIdToSymbolCache = undefined;
}

interface PricedPosition {
  instrument: string;
  brokerInstrumentId: number | null;
  side: "BUY" | "SELL" | "unknown";
  units: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealisedPnl: number | null;
  pricingSource: "broker" | "unavailable";
  pricingFailureReason: string | null;
}

/** `"BTC" (broker instrument id 100000)` / `"BTC"` when no raw id is known — used to keep every
 * diagnostic message below consistent, and to always name both identities together rather than
 * just whichever one happened to be at hand. */
function describeInstrument(instrument: string, brokerInstrumentId: number | null): string {
  return brokerInstrumentId !== null ? `"${instrument}" (broker instrument id ${brokerInstrumentId})` : `"${instrument}"`;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Instrument-resolution defect fix. `getRate()` on an EtoroDemoBroker-shaped adapter refuses to
 * quote an instrument that THIS SPECIFIC broker instance has not itself resolved via
 * `resolveInstrument()` first (its own unresolved-instrument safety guard — never bypassed here).
 * getBrokerSnapshot() constructs a fresh, throwaway broker per request, so a prior request's
 * resolution (even the module-level idToSymbol cache's own one-time resolution pass) does NOT carry
 * over — every request must explicitly resolve the instruments it is about to price, on the broker
 * instance it is about to price them with. Brokers with no resolution concept at all
 * (`!hasInstrumentResolution`) skip this step and are queried directly.
 *
 * Also cross-checks the resolved instrument id against this position's own known
 * `brokerInstrumentId` (from the raw portfolio read) when both are known — resolving the friendly
 * display symbol to a DIFFERENT instrument than the position's own raw id would silently price
 * against the wrong market; this is refused rather than risking a mismatched, wrong-looking figure.
 */
async function ensureResolvedForPricing(
  broker: PaperBroker,
  instrument: string,
  brokerInstrumentId: number | null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!hasInstrumentResolution(broker)) return { ok: true };

  try {
    const resolved = await broker.resolveInstrument(instrument);
    if (brokerInstrumentId !== null && resolved.instrumentId !== brokerInstrumentId) {
      return {
        ok: false,
        reason:
          `${describeInstrument(instrument, brokerInstrumentId)} resolved to a different eToro instrument ` +
          `(id ${resolved.instrumentId}) than this position's own broker instrument id — refusing to price against a mismatched instrument.`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: `Could not resolve ${describeInstrument(instrument, brokerInstrumentId)} for live pricing: ${toMessage(error)}`,
    };
  }
}

/**
 * Missing-financial-data fix. Prices every position in ONE pass — a single shared `pricingTimestamp`
 * for the whole batch (requirement 7's own "one coherent snapshot," never one fetch per position
 * spread over time) — and computes each one's own unrealised P/L via the exact same
 * calculateUnrealizedPnl("UNITS", ...) formula (calculateRealisedPnl's own live-price sibling, with
 * a live current price standing in for an eventual exit price). A position is left `pricingSource:
 * "unavailable"` (never a guessed/zero/carried-over price) whenever its side is "unknown", its
 * units/entryPrice are missing, the broker can't quote at all, its instrument can't be resolved on
 * this broker instance (see ensureResolvedForPricing above), or its quote fetch itself fails —
 * every such gap is reported, never silently absorbed into a total that then claims completeness it
 * doesn't have.
 */
async function priceOpenPositions(
  broker: PaperBroker,
  positions: readonly Omit<PricedPosition, "currentPrice" | "unrealisedPnl" | "pricingSource" | "pricingFailureReason">[],
): Promise<{ priced: PricedPosition[]; complete: boolean; unavailableReason: string | null }> {
  if (!hasRateQuoting(broker)) {
    const reason = "The connected broker does not support live rate quoting.";
    const priced = positions.map((position) => ({
      ...position,
      currentPrice: null,
      unrealisedPnl: null,
      pricingSource: "unavailable" as const,
      pricingFailureReason: reason,
    }));
    return {
      priced,
      complete: positions.length === 0,
      unavailableReason: positions.length === 0 ? null : reason,
    };
  }

  const priced: PricedPosition[] = [];
  const unpriced: string[] = [];

  for (const position of positions) {
    if (position.side === "unknown" || position.units === null || position.entryPrice === null) {
      const missing = [
        position.side === "unknown" ? "side" : null,
        position.units === null ? "units" : null,
        position.entryPrice === null ? "entry price" : null,
      ].filter((field): field is string => field !== null);
      const reason = `Cannot price ${describeInstrument(position.instrument, position.brokerInstrumentId)}: missing ${missing.join("/")}.`;
      priced.push({ ...position, currentPrice: null, unrealisedPnl: null, pricingSource: "unavailable", pricingFailureReason: reason });
      unpriced.push(position.instrument);
      continue;
    }

    const resolution = await ensureResolvedForPricing(broker, position.instrument, position.brokerInstrumentId);
    if (!resolution.ok) {
      logger.warn("Hermes Integration API could not resolve an open position's instrument for live pricing — its unrealised P/L will be unavailable", {
        component: "hermes-integration-broker-snapshot",
        requestedDisplaySymbol: position.instrument,
        brokerInstrumentId: position.brokerInstrumentId,
        reason: resolution.reason,
      });
      priced.push({ ...position, currentPrice: null, unrealisedPnl: null, pricingSource: "unavailable", pricingFailureReason: resolution.reason });
      unpriced.push(position.instrument);
      continue;
    }

    try {
      const rate = await broker.getRate(position.instrument);
      // Matches market-decision-runner.ts's own closing-price convention: a BUY/long position is
      // realised by SELLING (at bid); a SELL/short position is realised by BUYING BACK (at ask).
      const currentPrice = position.side === "BUY" ? rate.bid : rate.ask;
      const unrealisedPnl = calculateUnrealizedPnl("UNITS", position.side, position.entryPrice, currentPrice, position.units);
      priced.push({ ...position, currentPrice, unrealisedPnl, pricingSource: "broker", pricingFailureReason: null });
    } catch (error) {
      const reason = `Could not fetch a live rate for resolved instrument ${describeInstrument(position.instrument, position.brokerInstrumentId)}: ${toMessage(error)}`;
      logger.warn("Hermes Integration API could not fetch a live rate for an open position — its unrealised P/L will be unavailable", {
        component: "hermes-integration-broker-snapshot",
        requestedDisplaySymbol: position.instrument,
        brokerInstrumentId: position.brokerInstrumentId,
        resolvedQuoteInstrument: position.instrument,
        reason: toMessage(error),
      });
      priced.push({ ...position, currentPrice: null, unrealisedPnl: null, pricingSource: "unavailable", pricingFailureReason: reason });
      unpriced.push(position.instrument);
    }
  }

  return {
    priced,
    complete: unpriced.length === 0,
    unavailableReason: unpriced.length === 0 ? null : `Could not fetch a live price for: ${unpriced.join(", ")}.`,
  };
}

export async function getBrokerSnapshot(): Promise<HermesBrokerSnapshot> {
  let config;
  try {
    config = getHermesExecutionConfig();
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Configuration error." };
  }

  const ephemeralAuditTrail = new InMemoryAuditTrail();
  const executionRunId = `hermes-integration-${Date.now()}`;
  const provider = config.brokerProvider;
  const accountMode = config.runtimeTrading.mode;

  let broker: PaperBroker;
  try {
    broker = await BrokerFactory.create(config, ephemeralAuditTrail, executionRunId, {
      provider,
      resetState: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Broker connection failed.";
    logger.warn("Hermes Integration API could not connect to the configured broker", {
      component: "hermes-integration-broker-snapshot",
      reason: message,
    });
    return { ok: false, message };
  }

  const account = broker.getAccount();
  const pricingTimestamp = new Date().toISOString();

  if (hasRawPortfolio(broker)) {
    try {
      const raw = await broker.getRawPortfolio();
      const idToSymbol = await resolveInstrumentIdMap(broker, config.hermesAgent.instrumentUniverse);
      const basePositions = raw.clientPortfolio.positions.map((position) => ({
        instrument: idToSymbol.get(position.instrumentID) ?? String(position.instrumentID),
        brokerInstrumentId: position.instrumentID,
        side: (position.isBuy === undefined ? "unknown" : position.isBuy ? "BUY" : "SELL") as "BUY" | "SELL" | "unknown",
        units: position.units ?? null,
        entryPrice: position.openRate ?? null,
        quantity: position.amount ?? null,
        openedAt: position.openDateTime ?? null,
        brokerPositionId: position.positionID !== undefined ? String(position.positionID) : null,
      }));

      const { priced, complete, unavailableReason } = await priceOpenPositions(broker, basePositions);
      const pricedByInstrument = new Map(priced.map((p, index) => [index, p]));

      const positions: HermesPositionDto[] = basePositions.map((base, index) => {
        const price = pricedByInstrument.get(index)!;
        return {
          instrument: base.instrument,
          brokerInstrumentId: base.brokerInstrumentId,
          side: base.side,
          quantity: base.quantity,
          units: base.units,
          entryPrice: base.entryPrice,
          currentPrice: price.currentPrice,
          unrealisedPnl: price.unrealisedPnl,
          pricingTimestamp: price.pricingSource === "broker" ? pricingTimestamp : null,
          pricingSource: price.pricingSource,
          pricingFailureReason: price.pricingFailureReason,
          openedAt: base.openedAt,
          provider,
          accountMode,
          brokerPositionId: base.brokerPositionId,
        };
      });

      return {
        ok: true,
        provider,
        accountMode,
        cash: account.cashBalance,
        positions,
        positionsAreLiveGroundTruth: true,
        unrealisedPnlComplete: complete,
        unrealisedPnlUnavailableReason: unavailableReason,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to read the broker's live portfolio.";
      logger.warn("Hermes Integration API could not read the live broker portfolio", {
        component: "hermes-integration-broker-snapshot",
        reason: message,
      });
      return { ok: false, message };
    }
  }

  // Generic fallback for any broker without a raw ground-truth read — reflects only what this
  // specific, freshly-constructed broker instance has itself tracked, which will not include
  // positions opened by a separate long-running runtime process. Prototype V1 is fixed to
  // eToro-demo (the branch above); this path exists for completeness, not for the current
  // deployment, and is documented as a known limitation rather than silently trusted.
  const fallbackBase = broker.getOpenPositions().map((position) => ({
    instrument: position.instrument,
    // No separate raw-id concept for a generic PaperBroker — `instrument` already IS its native
    // identifier, so there is nothing distinct to cross-check against.
    brokerInstrumentId: null,
    side: position.side as "BUY" | "SELL" | "unknown",
    units: position.quantity, // a non-eToro broker's own quantity already IS the true unit count.
    entryPrice: position.entryPrice,
    quantity: position.quantity,
    openedAt: position.entryTimestamp,
    brokerPositionId: position.brokerPositionId ?? null,
  }));
  const { priced: fallbackPriced, complete: fallbackComplete, unavailableReason: fallbackUnavailableReason } = await priceOpenPositions(
    broker,
    fallbackBase,
  );
  const fallbackPricedByIndex = new Map(fallbackPriced.map((p, index) => [index, p]));
  const positions: HermesPositionDto[] = fallbackBase.map((base, index) => {
    const price = fallbackPricedByIndex.get(index)!;
    return {
      instrument: base.instrument,
      brokerInstrumentId: base.brokerInstrumentId,
      side: base.side,
      quantity: base.quantity,
      units: base.units,
      entryPrice: base.entryPrice,
      currentPrice: price.currentPrice,
      unrealisedPnl: price.unrealisedPnl,
      pricingTimestamp: price.pricingSource === "broker" ? pricingTimestamp : null,
      pricingSource: price.pricingSource,
      pricingFailureReason: price.pricingFailureReason,
      openedAt: base.openedAt,
      provider,
      accountMode,
      brokerPositionId: base.brokerPositionId,
    };
  });
  return {
    ok: true,
    provider,
    accountMode,
    cash: account.cashBalance,
    positions,
    positionsAreLiveGroundTruth: false,
    unrealisedPnlComplete: fallbackComplete,
    unrealisedPnlUnavailableReason: fallbackUnavailableReason,
  };
}
