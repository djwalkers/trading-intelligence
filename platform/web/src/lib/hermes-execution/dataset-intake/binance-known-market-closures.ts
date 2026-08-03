import { createHash } from "node:crypto";
import { SUPPORTED_BINANCE_SYMBOLS, type BinanceSymbol } from "./binance-archive";

// Phase 4 — Historical Dataset Intake. A small, HAND-REVIEWED, source-controlled registry of Binance
// spot market closures verified to correspond to a genuine, documented exchange-wide event (never
// guessed, never inferred from a gap itself, never fetched or trusted remotely — the only input this
// module ever reads is its own committed array literal below). This is the ONLY mechanism by which a
// gap in a Binance archive/dataset may ever be accepted downstream (binance-archive.ts's
// `validateMonthlyArchiveRows`, backtest-dataset.ts's `validateCandleDataset`) — everywhere else, a
// gap is rejected exactly as before. Adding an entry here is a reviewed, committed code change, never
// a runtime or CLI-supplied override.

export const BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION = 1;

/** `"ALL_SPOT"` covers every symbol this pipeline acquires (`SUPPORTED_BINANCE_SYMBOLS`) — a
 * deliberately closed, explicit expansion (see `expandSymbolScope`), never a wildcard interpreted
 * more broadly than the symbols this codebase actually knows about. */
export type BinanceClosureSymbolScope = BinanceSymbol | "ALL_SPOT";

/** Only one status is currently supported. A `"PROPOSED"`/`"REJECTED"`/etc. lifecycle is deliberately
 * NOT modelled here — an entry in this file is either a reviewed, committed, verified exception, or
 * it does not exist in the file at all. */
export type BinanceClosureStatus = "VERIFIED_EXCEPTION";

export interface BinanceKnownMarketClosure {
  provider: "BINANCE";
  market: "SPOT";
  appliesToSymbols: readonly BinanceClosureSymbolScope[];
  timeframe: "1h";
  /** The exact UTC open time of the ONE missing hourly candle this entry explains — canonical
   * `Date.prototype.toISOString()` form, exactly hour-aligned (see `isHourAlignedIsoTimestamp`).
   * Never a range: a multi-hour closure is declared as one entry per missing hour. */
  missingOpenTime: string;
  reasonCode: string;
  /** Human-readable explanation — never itself trusted as evidence; `sourceReference` carries the
   * citation. */
  description: string;
  /** Informational citation/reference text only — this module never fetches or verifies this URL/text
   * remotely; it exists purely for a human reviewer's evidence trail. */
  sourceReference: string;
  status: BinanceClosureStatus;
}

/**
 * Initial entry — the documented 2023-03-24 Binance spot exchange-wide system outage. `BTCUSDT` is
 * the specifically evidenced pair (see DATASET_INTAKE_PHASE4.md's own Binance section); scoped to
 * `ALL_SPOT` because the outage was exchange-wide, not pair-specific, so it is expected to explain the
 * identical missing hour for `ETHUSDT`/`SOLUSDT` archives as well.
 */
export const BINANCE_KNOWN_MARKET_CLOSURES: readonly BinanceKnownMarketClosure[] = [
  {
    provider: "BINANCE",
    market: "SPOT",
    appliesToSymbols: ["ALL_SPOT"],
    timeframe: "1h",
    missingOpenTime: "2023-03-24T15:00:00.000Z",
    reasonCode: "EXCHANGE_SYSTEM_OUTAGE",
    description: "Binance spot trading suspension during temporary system maintenance",
    sourceReference: "Binance exchange-wide system outage, 2023-03-24 (informational citation only — never fetched or trusted remotely at runtime)",
    status: "VERIFIED_EXCEPTION",
  },
];

const HOUR_MS = 3_600_000;

/** Rejects anything that isn't the CANONICAL `toISOString()` form of an exact hour boundary — a
 * registry entry with sub-hour precision, a non-UTC offset, or an otherwise non-canonical string is a
 * malformed entry, never silently normalised. */
export function isHourAlignedIsoTimestamp(value: string): boolean {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return false;
  if (new Date(ms).toISOString() !== value) return false;
  return ms % HOUR_MS === 0;
}

function expandSymbolScope(scope: readonly BinanceClosureSymbolScope[]): Set<BinanceSymbol> {
  const expanded = new Set<BinanceSymbol>();
  for (const entry of scope) {
    if (entry === "ALL_SPOT") {
      for (const symbol of SUPPORTED_BINANCE_SYMBOLS) expanded.add(symbol);
    } else {
      expanded.add(entry);
    }
  }
  return expanded;
}

export interface ClosureRegistryConflict {
  detail: string;
}

/**
 * Validates the registry's OWN internal consistency — malformed/non-canonical timestamps, an empty or
 * unrecognised symbol scope, an unsupported provider/market/timeframe/status, and any two entries
 * whose expanded symbol sets intersect at the identical `missingOpenTime` (duplicate/overlapping
 * closure records) — never trusted merely because it is committed source. Pure; returns every
 * conflict found, never just the first.
 */
export function findClosureRegistryConflicts(registry: readonly BinanceKnownMarketClosure[]): ClosureRegistryConflict[] {
  const conflicts: ClosureRegistryConflict[] = [];
  registry.forEach((entry, index) => {
    if (entry.provider !== "BINANCE" || entry.market !== "SPOT" || entry.timeframe !== "1h") {
      conflicts.push({ detail: `entry[${index}]: unsupported provider/market/timeframe (${entry.provider}/${entry.market}/${entry.timeframe})` });
    }
    if (entry.status !== "VERIFIED_EXCEPTION") {
      conflicts.push({ detail: `entry[${index}]: unsupported status ${JSON.stringify(entry.status)}` });
    }
    if (entry.appliesToSymbols.length === 0) {
      conflicts.push({ detail: `entry[${index}]: appliesToSymbols must not be empty` });
    }
    if (entry.appliesToSymbols.includes("ALL_SPOT") && entry.appliesToSymbols.length > 1) {
      conflicts.push({
        detail: `entry[${index}]: appliesToSymbols combines "ALL_SPOT" with an explicit symbol (${entry.appliesToSymbols.join(", ")}) — ambiguous and redundant; declare either "ALL_SPOT" alone or a specific symbol list, never both`,
      });
    }
    for (const symbol of entry.appliesToSymbols) {
      if (symbol !== "ALL_SPOT" && !(SUPPORTED_BINANCE_SYMBOLS as readonly string[]).includes(symbol)) {
        conflicts.push({ detail: `entry[${index}]: unrecognised symbol scope ${JSON.stringify(symbol)}` });
      }
    }
    if (!isHourAlignedIsoTimestamp(entry.missingOpenTime)) {
      conflicts.push({ detail: `entry[${index}]: missingOpenTime ${JSON.stringify(entry.missingOpenTime)} is not a canonical, hour-aligned UTC ISO timestamp` });
    }
  });
  for (let i = 0; i < registry.length; i++) {
    for (let j = i + 1; j < registry.length; j++) {
      if (registry[i]!.missingOpenTime !== registry[j]!.missingOpenTime) continue;
      const overlap = [...expandSymbolScope(registry[i]!.appliesToSymbols)].filter((s) => expandSymbolScope(registry[j]!.appliesToSymbols).has(s));
      if (overlap.length > 0) {
        conflicts.push({
          detail: `entry[${i}] and entry[${j}] both cover ${overlap.join(", ")} at ${registry[i]!.missingOpenTime} — duplicate/overlapping closure entries are never permitted`,
        });
      }
    }
  }
  return conflicts;
}

// Fails fast at import time — a malformed committed registry must never silently reach a caller that
// then trusts it to explain a real gap.
const REGISTRY_CONFLICTS = findClosureRegistryConflicts(BINANCE_KNOWN_MARKET_CLOSURES);
if (REGISTRY_CONFLICTS.length > 0) {
  throw new Error(`binance-known-market-closures.ts: invalid registry — ${REGISTRY_CONFLICTS.map((c) => c.detail).join("; ")}`);
}

// Pre-commit review fix. TypeScript's `readonly` is a compile-time-only guarantee — nothing at
// runtime previously stopped a caller (accidental or malicious) from mutating an already-validated
// entry in place (e.g. `BINANCE_KNOWN_MARKET_CLOSURES[0].reasonCode = "..."`), which would silently
// invalidate the self-validation that already ran above without ever re-running it. Deep-frozen here,
// AFTER validation, so every consumer (`findClosureRecord`, `resolveKnownMissingOpenTimesForSymbolMonth`)
// is provably reading the exact, validated, committed literal for the lifetime of the process — any
// mutation attempt throws (this module always runs under ESM strict-mode semantics) rather than
// silently succeeding and drifting from what was validated.
for (const entry of BINANCE_KNOWN_MARKET_CLOSURES) {
  Object.freeze(entry.appliesToSymbols);
  Object.freeze(entry);
}
Object.freeze(BINANCE_KNOWN_MARKET_CLOSURES);

/** Deterministic identity for one (registry entry, resolved symbol) pair — a sha256 over the entry's
 * own evidentiary fields plus the registry's version, so the identity changes if the reason, status,
 * or registry version ever changes, and differs per resolved symbol even for one shared `ALL_SPOT`
 * entry. Recorded on every `DatasetKnownClosure` attached to a prepared dataset as `closureId`. */
export function closureRecordIdentity(entry: BinanceKnownMarketClosure, symbol: BinanceSymbol): string {
  const canonical = `${entry.provider}|${entry.market}|${symbol}|${entry.timeframe}|${entry.missingOpenTime}|${entry.reasonCode}|${entry.status}|v${BINANCE_KNOWN_MARKET_CLOSURES_REGISTRY_VERSION}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** Every hourly open time within the given calendar month ("YYYY-MM") the registry declares as a
 * verified, explained closure for `symbol` — used by `validateMonthlyArchiveRows`
 * (binance-archive.ts) to accept ONLY an exactly-covered gap, never a guessed or broader one. */
export function resolveKnownMissingOpenTimesForSymbolMonth(symbol: BinanceSymbol, month: string): Set<string> {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const mo = Number(monthStr);
  const monthStartMs = Date.UTC(year, mo - 1, 1);
  const monthEndMs = Date.UTC(year, mo, 1);
  const result = new Set<string>();
  for (const entry of BINANCE_KNOWN_MARKET_CLOSURES) {
    if (!expandSymbolScope(entry.appliesToSymbols).has(symbol)) continue;
    const ms = Date.parse(entry.missingOpenTime);
    if (ms >= monthStartMs && ms < monthEndMs) result.add(entry.missingOpenTime);
  }
  return result;
}

/** The single verified registry entry (if any) explaining `symbol`'s missing hour at
 * `missingOpenTime` — used to build the fully-resolved `DatasetKnownClosure` record attached to a
 * prepared Phase 2 dataset document. `findClosureRegistryConflicts` already guarantees at most one
 * entry can ever match a given (symbol, missingOpenTime) pair. */
export function findClosureRecord(symbol: BinanceSymbol, missingOpenTime: string): BinanceKnownMarketClosure | undefined {
  return BINANCE_KNOWN_MARKET_CLOSURES.find((entry) => entry.missingOpenTime === missingOpenTime && expandSymbolScope(entry.appliesToSymbols).has(symbol));
}
