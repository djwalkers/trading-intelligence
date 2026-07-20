/**
 * A minimal, dependency-free client for Trading212's public API. Trading212 publishes no official
 * SDK; this is a plain `fetch` wrapper. Authentication is HTTP Basic auth — an API Key + API
 * Secret pair, base64-encoded and sent as `Authorization: Basic ...` — per Trading212's current
 * official docs (https://docs.trading212.com/api/section/authentication): "provide your API Key
 * as the username and your API Secret as the password, formatted as an HTTP Basic Authentication
 * header." No request signing beyond that (unlike Hyperliquid), so no signing dependency is needed.
 *
 * `TRADING212_DEMO_BASE_URL` is the only base URL this file knows about. There is no
 * `TRADING212_LIVE_BASE_URL` constant anywhere in this module — live support does not exist
 * structurally, not just by runtime rejection.
 */
export const TRADING212_DEMO_BASE_URL = "https://demo.trading212.com";

/** Raw Trading212 response/request shapes — kept local to this adapter. Nothing outside
 * src/lib/hermes-execution/trading212/ ever sees one of these. */
export interface Trading212Account {
  id: number;
  currencyCode: string;
}

export interface Trading212Cash {
  free: number;
  total: number;
  invested: number;
  ppl: number;
  result: number;
  blocked?: number;
  pieCash?: number;
}

export interface Trading212Position {
  ticker: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  ppl: number;
  fxPpl?: number;
  initialFillDate: string;
  maxBuy: number;
  maxSell: number;
  pieQuantity?: number;
  frontend?: string;
}

export type Trading212OrderStatus =
  | "LOCAL"
  | "UNCONFIRMED"
  | "CONFIRMED"
  | "NEW"
  | "CANCELLING"
  | "CANCELLED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED"
  | "REPLACING"
  | "REPLACED";

export interface Trading212Order {
  id: number;
  ticker: string;
  type: "LIMIT" | "STOP" | "MARKET" | "STOP_LIMIT";
  status: Trading212OrderStatus;
  strategy: "QUANTITY" | "VALUE";
  quantity?: number;
  value?: number;
  filledQuantity?: number;
  filledValue?: number;
  limitPrice?: number;
  stopPrice?: number;
  creationTime: string;
}

// Confirmed against a live, authenticated call to GET /api/v0/equity/metadata/instruments (see
// docs/trading212-demo-adapter-phase-1.md): the real response has no `minTradeQuantity` field —
// despite the OpenAPI spec documenting one — and uses `shortName` (camelCase), not `shortname`.
export interface Trading212Instrument {
  ticker: string;
  name: string;
  shortName?: string;
  type: string;
  currencyCode: string;
  maxOpenQuantity: number;
  /** Links to a Trading212Exchange's `workingSchedules[].id` (via getExchanges()) — the
   * authoritative source for whether this instrument's market is currently open. Optional: not
   * independently confirmed present on every instrument type, only on AAPL_US_EQ. */
  workingScheduleId?: number;
}

// Confirmed against a live, authenticated call to GET /api/v0/equity/metadata/exchanges: each
// working schedule is a chronological list of session-boundary events. `type` values observed:
// "PRE_MARKET_OPEN", "OPEN", "AFTER_HOURS_OPEN", "OVERNIGHT_OPEN" (session starts) and "CLOSE",
// "AFTER_HOURS_CLOSE" (session ends) — kept as `string`, not a union, since the full set across
// every exchange hasn't been independently enumerated.
export interface Trading212TimeEvent {
  date: string;
  type: string;
}

export interface Trading212WorkingSchedule {
  id: number;
  timeEvents: Trading212TimeEvent[];
}

export interface Trading212Exchange {
  id: number;
  name: string;
  workingSchedules: Trading212WorkingSchedule[];
}

/** Every error this client throws — bad/missing key, missing scope, or a validation failure
 * (`PlaceOrderError`, e.g. `InsufficientResources`, `SellingEquityNotOwned`) — becomes one of
 * these. The response body is safe to surface: it's server-returned text, never an echo of the
 * request's own Authorization header. */
export class Trading212ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(describeError(status, body));
    this.name = "Trading212ApiError";
  }
}

function describeError(status: number, body: unknown): string {
  if (status === 401) return "Trading212 rejected the API key (401 Bad API key).";
  if (status === 403) {
    return `Trading212 API key is missing a required scope (403): ${JSON.stringify(body)}`;
  }
  if (status === 429) return "Trading212 API rate limit exceeded (429).";
  if (body && typeof body === "object" && "code" in body) {
    return `Trading212 rejected the request (${status}): ${(body as { code: unknown }).code}`;
  }
  return `Trading212 API request failed with status ${status}.`;
}

/** Thin, single-purpose fetch wrapper — GET/POST/DELETE against the Trading212 Demo API only. */
export class Trading212Client {
  /** Precomputed once at construction — never rebuilt or logged per-request. */
  private readonly authorizationHeader: string;

  constructor(apiKey: string, apiSecret: string) {
    // Per Trading212's current official auth docs (docs.trading212.com/api/section/
    // authentication): "provide your API Key as the username and your API Secret as the
    // password, formatted as an HTTP Basic Authentication header" — base64(apiKey:apiSecret),
    // prefixed "Basic ". Neither credential is ever logged, including here.
    const encoded = Buffer.from(`${apiKey}:${apiSecret}`, "utf-8").toString("base64");
    this.authorizationHeader = `Basic ${encoded}`;
  }

  private async request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${TRADING212_DEMO_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: this.authorizationHeader,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      let parsedBody: unknown;
      try {
        parsedBody = await response.json();
      } catch {
        parsedBody = undefined;
      }
      throw new Trading212ApiError(response.status, parsedBody);
    }

    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  getAccountInfo(): Promise<Trading212Account> {
    return this.request("GET", "/api/v0/equity/account/info");
  }

  getAccountCash(): Promise<Trading212Cash> {
    return this.request("GET", "/api/v0/equity/account/cash");
  }

  getPortfolio(): Promise<Trading212Position[]> {
    return this.request("GET", "/api/v0/equity/portfolio");
  }

  getInstruments(): Promise<Trading212Instrument[]> {
    return this.request("GET", "/api/v0/equity/metadata/instruments");
  }

  /** Rate-limited to 1 request / 30s per Trading212's docs — call sparingly (e.g. only to explain
   * an order stuck in NEW), never on a hot path like connect() or polling. */
  getExchanges(): Promise<Trading212Exchange[]> {
    return this.request("GET", "/api/v0/equity/metadata/exchanges");
  }

  /** `quantity` is signed per Trading212's own convention: positive buys, negative sells. */
  placeMarketOrder(ticker: string, quantity: number): Promise<Trading212Order> {
    return this.request("POST", "/api/v0/equity/orders/market", { ticker, quantity });
  }

  getOrder(id: number): Promise<Trading212Order> {
    return this.request("GET", `/api/v0/equity/orders/${id}`);
  }

  cancelOrder(id: number): Promise<void> {
    return this.request("DELETE", `/api/v0/equity/orders/${id}`);
  }
}
