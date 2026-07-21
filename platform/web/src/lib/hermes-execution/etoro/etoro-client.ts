/**
 * A minimal, dependency-free client for eToro's official Public API. eToro publishes no official
 * Node/TypeScript SDK; this is a plain `fetch` wrapper — only browser automation, unofficial
 * wrappers, and reverse-engineered endpoints were excluded, per this phase's scope.
 *
 * ## Documentation confidence (read before trusting any DTO below)
 *
 * No eToro API credentials were available while building this adapter (see
 * docs/etoro-demo-adapter-phase-1.md's "Documentation / live-response discrepancies" section for
 * the full account). Every endpoint path and payload shape here comes from eToro's official
 * documentation (api-portal.etoro.com, builders.etoro.com) — but that documentation is fetched and
 * summarized through an automated tool, not read as raw HTML/OpenAPI JSON, and different fetches of
 * the *same* endpoint returned inconsistent field casing (e.g. `instrumentId` vs `instrumentID`,
 * `displayName` vs `displayname`). Every DTO field below is marked in a comment as either
 * "verbatim in a request-body example" (high confidence) or "documented description only, casing
 * unconfirmed" (lower confidence).
 *
 * UPDATE: instrument discovery (`EtoroInstrumentSearchResult`/`searchInstruments`) and rate
 * retrieval (`EtoroRate`/`getRates`) have since been confirmed against real, live responses and
 * corrected — see each type's own doc comment for what changed. `EtoroPosition`, `EtoroPendingOrder`,
 * `EtoroDemoPortfolio`, `EtoroOrderExecutionResult`, and `EtoroConfirmationResult` are still
 * unconfirmed — given the pattern found twice now (search and rates both actually use capital-ID
 * `instrumentID`), treat any `instrumentId` (lowercase d) elsewhere in this file as suspect until
 * it, too, is checked against a live response.
 *
 * ## v1 vs v2 — the specific discrepancy this phase was warned about
 *
 * eToro's docs mix versions: instrument search and market-close-orders are still under
 * `/api/v1/...`, while opening a position moved to a "unified" `/api/v2/trading/execution/orders`
 * (`/demo/orders` for demo) — confirmed by multiple independent sources including this phase's own
 * brief. An older guide page still shows the v1 open-order shape; it was NOT used here. See the
 * phase doc for the full endpoint-by-endpoint version reasoning.
 */
import { randomUUID } from "node:crypto";

export const ETORO_BASE_URL = "https://public-api.etoro.com";

// --- Market data DTOs -----------------------------------------------------------------------

/**
 * GET /api/v1/market-data/instruments response entry — CONFIRMED against a live response (see
 * docs/etoro-demo-adapter-phase-1.md's discrepancies section for the full account). This
 * supersedes an earlier, documentation-only guess that targeted `/api/v1/market-data/search`
 * instead: that path is real and returns HTTP 200, but its payload is an unrelated market-screener
 * dataset (1000+ fundamental-analysis fields per item, no stable per-instrument id/symbol schema)
 * — not instrument search results. `/api/v1/market-data/instruments` is the correct source for
 * `instrumentID`/`symbolFull`/`instrumentDisplayName`, confirmed live for Bitcoin
 * (`instrumentID: 100000, symbolFull: "BTC", instrumentDisplayName: "Bitcoin"`).
 *
 * Field names are exactly as returned — note the capital-ID casing (`instrumentID`, not
 * `instrumentId`), which differs from this same adapter's other DTOs (e.g. `EtoroPosition.
 * instrumentId`) built from documentation before any live response was available.
 *
 * No `isTradable`/`isCurrentlyTradable`/`isDelisted`-equivalent field exists anywhere in this
 * response — an earlier version of this type declared one (`isTradable`) that was never actually
 * present, making its "exclude non-tradable" filter a silent no-op. Tradability is not knowable
 * from this endpoint at all.
 */
export interface EtoroInstrumentSearchResult {
  instrumentID: number;
  instrumentDisplayName: string;
  symbolFull: string;
  instrumentTypeID: number;
  exchangeID: number;
}

/**
 * This endpoint does not support server-side free-text filtering — every query-param spelling
 * tried live (`searchText`, `query`, `q`, `text`, `symbol`, `searchTerm`, `keyword`, `keywords`,
 * `name`, `term`, `instrumentName`, `assetName`) returned the identical, complete ~16,000-
 * instrument universe. Its real (documented) filters are ID-based (`instrumentIds`, `exchangeIds`,
 * `stocksIndustryIds`, `instrumentTypeIds`), which can't help with a human-readable search term —
 * so matching is done client-side, in EtoroDemoBroker.resolveInstrument.
 */
export interface EtoroInstrumentSearchResponse {
  instrumentDisplayDatas: EtoroInstrumentSearchResult[];
}

/**
 * GET /api/v1/market-data/instruments/rates entry — CONFIRMED against live responses for two
 * instruments (BTC id 100000, and an unrelated low-profile instrument id 100681): `instrumentID`
 * (capital ID, matching `/market-data/instruments`' casing — NOT this file's previous
 * `instrumentId` guess, which never matched a real response). `bid`/`ask` were numeric in both
 * live responses observed; kept optional anyway since neither instrument tried was a case of a
 * quoteless/suspended entry, so that scenario hasn't actually been ruled out, only not observed.
 * `date` is a variable-precision ISO-8601 timestamp (e.g. "2026-07-20T08:59:45.2562542Z") — kept
 * as `string`, never parsed further here.
 *
 * Only the fields this adapter actually reads are declared (see Trading212Instrument's identical
 * convention) — the live response also includes `lastExecution`, `conversionRateAsk/Bid`,
 * `unitMargin`/`unitMarginAsk`/`unitMarginBid`, `priceRateID`, `bidDiscounted`, `askDiscounted`,
 * `unitMarginBidDiscounted`, `unitMarginAskDiscounted`, none of which anything here needs.
 */
export interface EtoroRate {
  instrumentID: number;
  bid?: number;
  ask?: number;
  date?: string;
}

/**
 * CONFIRMED live: requesting an instrument id eToro doesn't return a rate for yields HTTP 200 with
 * an EMPTY `rates` array (`{"rates":[]}`) — not a per-id null/placeholder entry, not an error. This
 * is the "instrument absent from the response" case EtoroDemoBroker.getRate must distinguish from
 * "present but unpriced" (a rates entry that exists but lacks bid/ask — not observed live, kept as
 * a distinct, defensive case regardless).
 *
 * Also confirmed live: this endpoint does NOT accept the comma-separated `instrumentIds` list its
 * name implies — `instrumentIds=100000,200000` is rejected with HTTP 400 ("not a valid integer").
 * Not fixed here: `getRates()` is only ever called with a single id (`getRate()` resolves one
 * instrument at a time), so `[id].join(",")` never actually produces a comma and this limitation
 * doesn't affect any current code path.
 */
export interface EtoroRatesResponse {
  rates: EtoroRate[];
}

// --- Trading/portfolio DTOs ------------------------------------------------------------------

/**
 * An open CFD position as eToro's demo portfolio reports it — CONFIRMED against a live response
 * (two real positions observed, both opened by this adapter's own smoke-test runs). Real fields
 * include `positionID`, `orderID` (links back to the order-submission response's `orderId` — the
 * only reliable reconciliation path when the order response itself has no `positionId`; see
 * EtoroDemoBroker.reconcilePosition), `instrumentID`, `isBuy`, `amount`, `openRate`, `units`,
 * `leverage`, `openDateTime`, plus many account/fee/settlement fields
 * (CID, totalFees, isSettled, settlementTypeID, ...) this adapter has no use for and doesn't model.
 */
export interface EtoroPosition {
  positionID: number;
  orderID: number;
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
  units?: number;
  openRate?: number;
  openDateTime?: string;
  leverage?: number;
}

/**
 * NOT observed live — every live portfolio check so far shows an empty `orders` array (market
 * orders settle instantly in this demo environment, so nothing has ever stayed pending long enough
 * to appear here). Modeled by analogy to the confirmed capital-ID casing convention used
 * everywhere else in this API (instruments, rates, positions) — treat as inferred, not confirmed,
 * until a genuinely pending order is observed live.
 */
export interface EtoroPendingOrder {
  orderID: number;
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
}

/**
 * GET /api/v1/trading/info/demo/portfolio — CONFIRMED against a live response: everything is
 * nested under a top-level `clientPortfolio` object, not returned flat as this file previously
 * assumed. `credit` is the demo account's real, live virtual balance (confirmed, e.g. 103169.71) —
 * this is what EtoroDemoBroker.getAccount() reads; the real response also includes `mirrors`,
 * `stockOrders`, `entryOrders`, `exitOrders`, `ordersForOpen`, `ordersForClose`,
 * `ordersForCloseMultiple`, and `bonusCredit`, none of which anything here needs.
 */
export interface EtoroDemoPortfolio {
  clientPortfolio: {
    positions: EtoroPosition[];
    orders: EtoroPendingOrder[];
    credit: number;
  };
}

/**
 * POST /api/v2/trading/execution/demo/orders response — CONFIRMED against a live order
 * submission: exactly `{ orderId, token }`, no `positionId`. Kept as all-optional since an earlier,
 * different-shaped example (`requestToken`/`positionId`) was found in documentation and not yet
 * ruled out for every order type — but for the plain market-order case this adapter submits, only
 * `orderId`/`token` are ever populated live. Reconciling `orderId` into a concrete position (via
 * `EtoroPosition.orderID`) is EtoroDemoBroker.reconcilePosition's job, not this client's.
 */
export interface EtoroOrderExecutionResult {
  orderId?: number;
  positionId?: number;
  token?: string;
  requestToken?: string;
}

/** DELETE .../market-close-orders/{orderId} (cancel a pending close order) and the close-position
 * call both return a bare confirmation token per eToro's documented example. */
export interface EtoroConfirmationResult {
  token?: string;
}

// --- Errors -----------------------------------------------------------------------------------

/** Every non-2xx response becomes one of these. `safeMessage` is deliberately extracted from a
 * small set of known "message"-like fields, never a full JSON.stringify of the body — eToro error
 * bodies are not confirmed never to echo request data. */
export class EtoroApiError extends Error {
  constructor(
    public readonly operation: string,
    public readonly status: number,
    public readonly requestId: string,
    public readonly brokerErrorCode: string | undefined,
    public readonly safeMessage: string,
  ) {
    super(
      `eToro ${operation} failed (HTTP ${status}${brokerErrorCode ? `, code=${brokerErrorCode}` : ""}): ` +
        `${safeMessage} [request-id=${requestId}]`,
    );
    this.name = "EtoroApiError";
  }
}

function extractBrokerErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;
  const code = record.errorCode ?? record.code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function extractSafeMessage(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const candidate = record.message ?? record.error ?? record.errorMessage ?? record.description;
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return `eToro API request failed with status ${status}.`;
}

/** Prototype V1 — Reliability Fix. Thrown when a single HTTP request exceeds its bounded timeout
 * (confirmed via live testing: an unbounded request can otherwise hang a trading cycle, and
 * transitively TradingRuntime.stop(), indefinitely — see runtime/trading-runtime.ts's own
 * shutdownTimeoutMs for the second, independent bound). Deliberately carries only `operation` and
 * `timeoutMs` — never the URL, headers, or body, so it can never echo a credential even
 * incidentally, matching EtoroApiError's own "safeMessage only" discipline above. */
export class EtoroTimeoutError extends Error {
  constructor(
    public readonly operation: string,
    public readonly timeoutMs: number,
  ) {
    super(`eToro ${operation} timed out after ${timeoutMs}ms.`);
    this.name = "EtoroTimeoutError";
  }
}

// --- Client -------------------------------------------------------------------------------------

/** Thin, single-purpose fetch wrapper — GET/POST/DELETE against eToro's Public API only. Every
 * request gets its own `x-request-id` (a fresh UUID) for traceability; never reused, never logged
 * as part of a header dump — only surfaced as a plain field on EtoroApiError. */
/** A single real API round-trip normally completes in well under a second — 10s is generous
 * headroom, not an expected duration. Only used when the caller doesn't supply its own (see
 * EtoroDemoConfig.httpTimeoutMs, which config.ts always populates for real use). */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

export class EtoroClient {
  constructor(
    private readonly apiKey: string,
    private readonly userKey: string,
    private readonly timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {}

  private async request<T>(
    operation: string,
    method: "GET" | "POST" | "DELETE",
    path: string,
    options?: { query?: Record<string, string>; body?: unknown },
  ): Promise<T> {
    const requestId = randomUUID();
    const url = new URL(`${ETORO_BASE_URL}${path}`);
    if (options?.query) {
      for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, value);
    }

    // Bounded via AbortController — previously unbounded, which live testing confirmed could hang
    // a whole trading cycle (and, transitively, graceful shutdown) indefinitely on a single stalled
    // request. `timer` is always cleared, on every exit path, so a fast/normal response never keeps
    // a stray timer alive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "x-api-key": this.apiKey,
          "x-user-key": this.userKey,
          "x-request-id": requestId,
          ...(options?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new EtoroTimeoutError(operation, this.timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        parsedBody = undefined;
      }
      throw new EtoroApiError(
        operation,
        response.status,
        requestId,
        extractBrokerErrorCode(parsedBody),
        extractSafeMessage(parsedBody, response.status),
      );
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * GET /api/v1/market-data/instruments — instrument discovery. `searchText` is sent defensively
   * (harmless if ignored, and would start working for free if eToro ever adds real server-side
   * filtering) but is confirmed NOT to filter this endpoint today — every call returns the
   * complete instrument universe (~16,000 entries, ~12MB), which the caller must filter
   * client-side (see EtoroDemoBroker.resolveInstrument).
   *
   * `/api/v1/market-data/search` (this method's original target) was a documentation-only guess
   * that turned out, once tested against a live response, to return an unrelated market-screener
   * dataset — see EtoroInstrumentSearchResult's doc comment.
   */
  searchInstruments(searchText: string): Promise<EtoroInstrumentSearchResponse> {
    return this.request("searchInstruments", "GET", "/api/v1/market-data/instruments", {
      query: { searchText },
    });
  }

  /** GET /api/v1/market-data/instruments/rates — current bid/ask for one or more instrument ids. */
  getRates(instrumentIds: number[]): Promise<EtoroRatesResponse> {
    return this.request("getRates", "GET", "/api/v1/market-data/instruments/rates", {
      query: { instrumentIds: instrumentIds.join(",") },
    });
  }

  /** GET /api/v1/trading/info/demo/portfolio — demo positions, pending orders, and account status.
   * Doubles as this adapter's credential/session verification call (no separate "whoami" endpoint
   * is documented) and as the only way to reconcile an order response into a concrete position,
   * since no dedicated "get order/position by id" endpoint was found. */
  getDemoPortfolio(): Promise<EtoroDemoPortfolio> {
    return this.request("getDemoPortfolio", "GET", "/api/v1/trading/info/demo/portfolio");
  }

  /** POST /api/v2/trading/execution/demo/orders — the current, unified demo execution route
   * (confirmed, not the legacy v1 guide's shape). `leverage: 1` is fixed, not configurable, so
   * this adapter can never open a leveraged position. */
  placeDemoMarketOrder(params: {
    instrumentId: number;
    isBuy: boolean;
    amount: number;
    orderCurrency: string;
  }): Promise<EtoroOrderExecutionResult> {
    return this.request("placeDemoMarketOrder", "POST", "/api/v2/trading/execution/demo/orders", {
      body: {
        action: "open",
        transaction: params.isBuy ? "buy" : "sell",
        instrumentId: params.instrumentId,
        orderType: "mkt",
        leverage: 1,
        amount: params.amount,
        orderCurrency: params.orderCurrency,
      },
    });
  }

  /**
   * POST /api/v1/trading/execution/demo/market-close-orders/positions/{positionId} — full close
   * (`unitsToDeduct: null`).
   *
   * UNCONFIRMED PATH: only the real-money variant of this endpoint
   * (`/api/v1/trading/execution/market-close-orders/positions/{positionId}`) was directly found in
   * documentation. This "demo/" segment is INFERRED by the same pattern every other confirmed
   * demo/real pair follows (`.../info/portfolio` vs `.../info/demo/portfolio`;
   * `/api/v2/.../orders` vs `/api/v2/.../demo/orders`) — not independently verified. Because the
   * path structurally contains "demo", the worst case if this guess is wrong is a 404 (a safe,
   * visible failure), never an accidental call to a confirmed real-money endpoint. See the phase
   * doc's discrepancy section before trusting this against a live account.
   */
  closeDemoPosition(instrumentId: number, positionId: number): Promise<EtoroConfirmationResult> {
    return this.request(
      "closeDemoPosition",
      "POST",
      `/api/v1/trading/execution/demo/market-close-orders/positions/${positionId}`,
      { body: { instrumentId, unitsToDeduct: null } },
    );
  }

  /**
   * DELETE /api/v1/trading/execution/demo/market-close-orders/{orderId} — cancels a pending CLOSE
   * order (not a pending OPEN order — eToro's documented cancellation endpoint is specifically
   * scoped to pending closes; no cancellation endpoint for a pending OPEN market order was found
   * at all).
   *
   * UNCONFIRMED PATH (same "demo/" inference as closeDemoPosition above): the only endpoint
   * directly documented was the real-money variant
   * (`/api/v1/trading/execution/market-close-orders/{orderId}`), whose only confirmed OAuth2 scope
   * was `etoro-public:real:write` — meaning a demo equivalent for cancellation could not be
   * confirmed to exist at all. Deliberately NOT called automatically anywhere in this adapter or
   * its smoke test (see EtoroDemoBroker) — a pending order instead surfaces as CLEANUP_REQUIRED,
   * never a guessed cancellation attempt.
   */
  cancelPendingCloseOrder(orderId: number): Promise<EtoroConfirmationResult> {
    return this.request(
      "cancelPendingCloseOrder",
      "DELETE",
      `/api/v1/trading/execution/demo/market-close-orders/${orderId}`,
    );
  }
}
