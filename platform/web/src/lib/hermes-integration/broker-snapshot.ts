import "server-only";
import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import { hasInstrumentResolution } from "@/lib/hermes-execution/runtime/position-reconciliation";
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

export interface HermesPositionDto {
  /** eToro exposes no human-readable symbol on a raw position (only a numeric instrumentID). Main
   * Dashboard Hermes/eToro fix: mapped back to the app's own configured instrument symbol (e.g.
   * "BTC") via resolveInstrumentIdMap() below whenever the broker supports instrument resolution
   * and the id is a KNOWN, resolved one — never a guessed mapping. Falls back to the raw numeric id
   * as a string only when genuinely unresolvable (an unrecognised instrument, or a broker with no
   * resolution capability at all) — see this module's own EtoroDemoBroker branch below. */
  instrument: string;
  side: "BUY" | "SELL" | "unknown";
  quantity: number | null;
  entryPrice: number | null;
  /** Not available without an additional live rates lookup per position (eToro's raw portfolio
   * response carries no current price) — always `null`, never fabricated. See "Known limitations"
   * in docs/hermes-integration-api.md. */
  currentPrice: null;
  /** Undeterminable without `currentPrice` above — always `null` for the same reason. */
  unrealisedPnl: null;
  openedAt: string | null;
  provider: string;
  accountMode: string;
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
        openRate?: number;
        openDateTime?: string;
      }>;
      credit: number;
    };
  }>;
}

function hasRawPortfolio(broker: PaperBroker): broker is PaperBroker & RawPortfolioBroker {
  return typeof (broker as Partial<RawPortfolioBroker>).getRawPortfolio === "function";
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

  if (hasRawPortfolio(broker)) {
    try {
      const raw = await broker.getRawPortfolio();
      const idToSymbol = await resolveInstrumentIdMap(broker, config.hermesAgent.instrumentUniverse);
      const positions: HermesPositionDto[] = raw.clientPortfolio.positions.map((position) => ({
        instrument: idToSymbol.get(position.instrumentID) ?? String(position.instrumentID),
        side: position.isBuy === undefined ? "unknown" : position.isBuy ? "BUY" : "SELL",
        quantity: position.amount ?? null,
        entryPrice: position.openRate ?? null,
        currentPrice: null,
        unrealisedPnl: null,
        openedAt: position.openDateTime ?? null,
        provider,
        accountMode,
      }));
      return { ok: true, provider, accountMode, cash: account.cashBalance, positions, positionsAreLiveGroundTruth: true };
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
  const positions: HermesPositionDto[] = broker.getOpenPositions().map((position) => ({
    instrument: position.instrument,
    side: position.side,
    quantity: position.quantity,
    entryPrice: position.entryPrice,
    currentPrice: null,
    unrealisedPnl: null,
    openedAt: position.entryTimestamp,
    provider,
    accountMode,
  }));
  return { ok: true, provider, accountMode, cash: account.cashBalance, positions, positionsAreLiveGroundTruth: false };
}
