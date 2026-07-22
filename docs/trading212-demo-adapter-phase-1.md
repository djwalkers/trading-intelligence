# Trading212 Demo Adapter — Phase 1

Replaces the "external broker proof" from the Hyperliquid Testnet Adapter phase with Trading212's
official public API, against its Demo (practice) environment — a second, independent proof that
the broker abstraction built in Execution MVP Phase 1 generalises to a real external venue, this
time a regulated retail equities broker rather than a crypto perp exchange.

**`LocalPaperBroker` remains the default and unmodified.** The execution engine, signal engine,
risk engine, and audit event shapes are all unchanged. This phase adds a third broker
implementation and a way to select it — exactly like the Hyperliquid phase did — without touching
anything upstream of the broker interface.

## Architecture

```
Execution Engine (unchanged)
        │
        ▼
Broker Interface (PaperBroker — unchanged, no new methods added)
        │
        ├── LocalPaperBroker            (Execution MVP Phase 1 — still the default)
        ├── HyperliquidTestnetBroker    (Hyperliquid Testnet Adapter phase)
        └── Trading212DemoBroker        (this phase)
                │
                ▼
        Trading212 Demo API (demo.trading212.com — never live.trading212.com)
```

### New files

```
src/lib/hermes-execution/
├── broker-factory.ts                        Extended: getBroker() now has a third branch
└── trading212/
    ├── trading212-client.ts                 Minimal fetch-based HTTP client (no new dependency)
    └── trading212-demo-broker.ts            Trading212DemoBroker (+ Trading212OrderPendingError)

src/hermes-execution/
└── broker-trading212-smoke.ts               CLI entrypoint (`npm run broker:trading212-smoke`)

tests/hermes-execution/
├── broker-factory.test.ts                   Extended with Trading212 branch coverage
└── trading212/
    ├── trading212-client.test.ts
    ├── config-trading212.test.ts
    └── trading212-demo-broker.test.ts       Mocked at the global `fetch` boundary
```

### Why no new dependency

Trading212 publishes no official SDK (unlike Hyperliquid, which needed a real signing library —
`@nktkas/hyperliquid` + `viem`). Its public API needs nothing beyond plain JSON-over-HTTPS with a
static HTTP Basic `Authorization` header (see Authentication below) — no request signing. Node's
built-in `fetch` and `Buffer` (for the base64 encoding Basic auth requires) are entirely
sufficient, so this phase adds zero new npm dependencies.

### Authentication

Per Trading212's **current official** authentication docs
(`https://docs.trading212.com/api/section/authentication`): "You must provide your API Key as the
username and your API Secret as the password, formatted as an HTTP Basic Authentication header,"
constructed as `Authorization: Basic ` + base64(`API_KEY:API_SECRET`). `Trading212Client` builds
this header once at construction (`Buffer.from(\`${apiKey}:${apiSecret}\`).toString("base64")`)
and never rebuilds, logs, or otherwise surfaces it afterward.

An earlier draft of this adapter used a single raw API key in the `Authorization` header, based on
this repo's own OpenAPI-spec snapshot and a third-party reference client that predates Trading212's
current documented Basic-auth flow. That single-key path has been fully removed — the current
official docs are unambiguous that both a key and a secret are required, and nothing in the actual
OpenAPI spec explicitly requires the old single-key format for any specific endpoint, so there was
no reason to keep it as a fallback.

### Why `closePosition()` and `placeMarketOrder()` share one internal method

Trading212's public API has **no dedicated "close position" endpoint**. A sell order *is* a market
order — Trading212's own convention is a **signed quantity**: positive buys, negative sells
(confirmed against the real API, not assumed). `closePosition()` and `placeMarketOrder()` both
call one private `submitOrderAndPollForFill()`, differing only in the sign of the quantity they
pass — this is a direct reflection of how the real API is shaped, not an implementation shortcut.

### Why order fills are polled, not instant

A market order's initial POST response can come back `NEW`/`UNCONFIRMED` rather than `FILLED` —
outside market hours, or simply due to normal exchange latency. This adapter polls
`GET /equity/orders/{id}` (respecting Trading212's own `1 request / 1s` rate limit on that
endpoint) until the order reaches `FILLED` or a terminal failure (`CANCELLED`/`REJECTED`), or gives
up after ~9 seconds and throws `Trading212OrderPendingError` — mirroring
`HyperliquidOrderRestingError` from the previous phase. The smoke test catches this and cancels the
pending order via `DELETE /equity/orders/{id}`.

### Why order sizing has no dollar cap (unlike the Hyperliquid adapter)

Trading212's public API has **no market-quote/price endpoint** — there is nothing to convert a
dollar amount into a share quantity against. The OpenAPI spec documents a `minTradeQuantity` field
on `TradeableInstrument`, but a live, authenticated call to `GET /equity/metadata/instruments`
confirmed the real response never includes it (verified against `AAPL_US_EQ`'s actual payload — no
`minTradeQuantity` key at all). The smoke test's order size is instead an explicit, validated
config value, `TRADING212_DEMO_TEST_QUANTITY` (default 1 share) — the honest answer once the
metadata-derived approach was proven not to work, not a value discovered from the API. The broker
also refuses locally (`submitOrderAndPollForFill`) if a quantity is ever non-finite or zero, so an
invalid quantity can never reach Trading212's order-placement endpoint.

### Account/position mapping

- `Account.cashBalance` ← `Cash.free` (immediately spendable cash); `Account.startingCashBalance`
  ← `Cash.total` (overall account value), captured once at `connect()` time — the same
  cash-vs-equity split the Hyperliquid adapter uses (`withdrawable` vs `accountValue`).
- A position's entry/exit price is derived from `filledValue / filledQuantity` on the order's own
  fill response (Trading212's `Order` schema has no separate "average price" field) — computed
  identically for both the opening and closing order, so realised P/L is a plain difference of two
  values obtained the same way.
- Only positions opened through a given `Trading212DemoBroker` instance are tracked, same as the
  Hyperliquid adapter — `getRawPortfolio()` (adapter-specific) returns Trading212's own full
  open-positions list for the smoke test's own reporting; `getOpenPositions()` (the shared
  interface method) only reflects this instance's own activity.

## Required environment variables

See `.env.example` for full per-variable documentation (placeholders only). Summary:

| Variable | Default | Notes |
|---|---|---|
| `BROKER_PROVIDER` | `local` | `local`, `hyperliquid-testnet`, or `trading212-demo`. No live value exists. |
| `TRADING212_API_KEY` | unset | Required (paired with the secret below) only when `BROKER_PROVIDER=trading212-demo`. Never logged. |
| `TRADING212_API_SECRET` | unset | Required (paired with the key above). Together they form the HTTP Basic `Authorization` header. Never logged. |
| `TRADING212_DEMO_EXECUTION_ENABLED` | `false` | A second, independent gate — must be explicitly `true`. |
| `TRADING212_DEMO_INSTRUMENT` | `AAPL_US_EQ` | The equity ticker the smoke test trades. |

There is no environment-variable *naming* convention imposed by Trading212 itself (its API takes
HTTP header values, not env vars) — these names follow this project's own convention. The
*credential shape* (key + secret, not a single key) does follow Trading212's own current, official
requirement — see Authentication above.

## Wallet/account preparation steps

Trading212 has no wallet to fund — it's a conventional broker account, not a blockchain venue:

1. Open the Trading212 app (or use an existing account) and switch to (or create) a
   **Practice/Demo** account — this is a distinct virtual-money account, not a setting on your real
   one.
2. Go to **Settings → API (Beta)**, accept the risk warning, and generate an API key **for the
   Demo account specifically**. Trading212 shows the **API Secret exactly once**, at generation
   time — copy it immediately; it cannot be retrieved again (only regenerated, invalidating the
   old key+secret pair).
3. Set `TRADING212_API_KEY` and `TRADING212_API_SECRET` in `.env.local` (already `.gitignore`d —
   never commit either).
4. Set `BROKER_PROVIDER=trading212-demo` and `TRADING212_DEMO_EXECUTION_ENABLED=true`.

## How to run the smoke command

```bash
cd platform/web
BROKER_PROVIDER=trading212-demo \
TRADING212_DEMO_EXECUTION_ENABLED=true \
TRADING212_API_KEY=... \
TRADING212_API_SECRET=... \
npm run broker:trading212-smoke
```

(Or set the four vars in `.env.local` and just run `npm run broker:trading212-smoke` — picked up
automatically, same as every other CLI in this project.) It does **not** run during
`npm run dev`/`npm run build`/app startup — only ever invoked explicitly.

## Safety boundaries

- **No live support exists.** Not "disabled" — structurally absent. `BrokerProvider`'s type is
  `"local" | "hyperliquid-testnet" | "trading212-demo"`; there is no fourth "trading212-live" value
  anywhere in this codebase, and `Trading212Client` hardcodes `TRADING212_DEMO_BASE_URL =
  "https://demo.trading212.com"` — there is no `TRADING212_LIVE_BASE_URL` constant defined anywhere
  in the adapter for it to accidentally use.
- **Two independent gates**, both required: `BROKER_PROVIDER=trading212-demo` selects the adapter;
  `TRADING212_DEMO_EXECUTION_ENABLED=true` is a second, separate flag the broker factory checks
  before ever constructing it. Neither alone is sufficient.
- **Never falls back.** An unrecognised `BROKER_PROVIDER`, a missing API key or secret, or the
  execution flag left off all throw a clear error — none silently default to `local` or anything
  else.
- **Smallest practical order size.** The smoke test always sizes to `TRADING212_DEMO_TEST_QUANTITY`
  (default 1 share), never a strategy-decided amount. `Trading212DemoBroker` also refuses locally
  (before ever calling the order API) if a computed quantity is non-finite or zero.
- **Duplicate-position guard.** `placeMarketOrder` refuses to open a second tracked position for an
  instrument that already has one — the same protection `LocalPaperBroker` and
  `HyperliquidTestnetBroker` both have.
- **Secrets never logged or committed.** Neither the API key nor the API secret ever appears in any
  audit event, log line, or thrown error message anywhere in this adapter (asserted directly in
  `tests/hermes-execution/trading212/trading212-demo-broker.test.ts` and
  `trading212-client.test.ts` against every recorded audit event and every thrown error). The Basic
  `Authorization` header itself is built once and never logged either.
  `.env.local` is `.gitignore`d; `.env.example` holds placeholders only.
- **No live-money path exists anywhere.** This phase adds exactly one new broker implementation,
  targeting exactly one non-production environment.

## Expected output

A passing run prints, in order: configuration validated → connected → account balance (free cash,
total cash — never the API key or secret) → test instrument confirmed → order size
(`TRADING212_DEMO_TEST_QUANTITY`) → order filled → position closed with realised P/L →
confirmation that no position remains open → `SMOKE TEST PASSED`, exit code 0.

There are three possible outcomes, not two — see the next section for why:

- `SMOKE TEST PASSED`, exit code 0 — the full lifecycle completed.
- `SMOKE TEST INCONCLUSIVE — MARKET CLOSED`, exit code 2 — the adapter worked correctly, but the
  order is legitimately queued, not broken (see below).
- `SMOKE TEST FAILED`, exit code 1 — a genuine failure. The script still attempts cleanup
  (cancel/close) before reporting failure wherever it safely can.

## Cleanup behaviour and the market-closed outcome

Every code path leads to a flat account:

- **Order fills immediately** → the script closes the resulting position with an opposite
  (negative-quantity) market order, then verifies via `getOpenPositions()` that nothing remains
  open for the test instrument.
- **Order doesn't reach FILLED within the poll window** (`Trading212OrderPendingError`) → the
  script cancels it via `cancelOrder()`; no position was ever opened, so there is nothing further
  to close.
- **Close order doesn't fill within the poll window** → the script cancels that pending order too
  (a position may remain open — the final summary says so explicitly rather than claiming
  success).

An order stuck in `NEW` isn't always a failure. Trading212's own docs state: "If placed when the
market is closed, the order will be queued to execute when the market next opens" — confirmed
against a live `GET /equity/metadata/exchanges` call, whose `workingSchedules[].timeEvents` give
the exact OPEN/CLOSE boundaries Trading212 itself uses (e.g. NASDAQ, `workingScheduleId` 71: a
weekday session of `PRE_MARKET_OPEN` → `OPEN` → `AFTER_HOURS_OPEN`, then a multi-day gap with no
events at all over the weekend before the next `OVERNIGHT_OPEN`/`PRE_MARKET_OPEN`). No amount of
polling changes this: the ~9-second poll window isn't "too short," it's simply irrelevant when the
exchange won't trade at any point during it.

So whenever `Trading212OrderPendingError` fires, the smoke test calls
`Trading212DemoBroker.describeMarketSession(ticker)`, which resolves the instrument's
`workingScheduleId` against `getExchanges()` and reads off whichever `timeEvents` entry is most
recent as of now:

- **Market confirmed `CLOSED`** → `SMOKE TEST INCONCLUSIVE — MARKET CLOSED`, exit code 2. This is
  the expected result of running the smoke test on a weekend, holiday, or off-hours for the test
  instrument — not evidence of an adapter bug.
- **Market confirmed `OPEN`, or session state `UNKNOWN`** (e.g. the exchanges lookup itself
  failed, or the instrument has no known working schedule) → still `SMOKE TEST FAILED`, exit code
  1. A stall that documented market-hours behaviour doesn't explain is a real problem worth
  investigating, not something to wave away.

The audit trail reflects this with a dedicated `SMOKE_TEST_INCONCLUSIVE` event type, distinct from
`SMOKE_TEST_COMPLETED`/`SMOKE_TEST_FAILED`.

The command is safe to run more than once: each run gets a fresh, timestamped execution-run id and
a fresh audit log file (`.data/hermes-execution/trading212-smoke-audit-log.json`, overwritten each
run, not accumulated) — nothing about a previous run's state is reused or assumed.

## Real network proof

**Pending.** No Trading212 Demo API credentials were available while building this phase, so
`npm run broker:trading212-smoke` has not been run against the real API. Everything above — the
adapter's request/response mapping, signed-quantity buy/sell logic, poll-until-filled behaviour,
safety gating, and cleanup — is proven only via mocked `fetch` responses
(`tests/hermes-execution/trading212/`, 267/267 tests passing including every pre-existing
Execution MVP and Hyperliquid Testnet Adapter test). When credentials are available, run the
command above and confirm a real `SMOKE TEST PASSED` with a genuine filled order, closed position,
and zero remaining exposure.

## Known limitations

- **No retry/backoff on transient network failures** — a dropped connection during `connect()` or
  an order call fails the whole run rather than retrying, same limitation as the Hyperliquid
  adapter.
- **Only long ("BUY") entries are opened via `placeMarketOrder`** — mirroring
  `LocalPaperBroker`/`HyperliquidTestnetBroker`'s own scope. The underlying "market sell"
  capability this phase's brief called for is fully implemented and tested — it powers
  `closePosition()` internally — but isn't exposed as a separate public entry action, since
  nothing in the execution engine would ever call it that way and Trading212's retail equity
  accounts don't support opening a short position regardless.
- **Only one instrument's exposure is tracked per broker instance** — adequate for a one-order
  smoke test, not for managing an entire real portfolio.
- **The ~9-second poll window may not be long enough outside market hours.** A market order placed
  when an exchange is closed can sit `NEW`/`UNCONFIRMED` far longer than that — the smoke test will
  correctly report a pending order and cancel it, but won't demonstrate a fill until run while the
  relevant market is open.
- **Account/position reads are a cached snapshot**, refreshed after each mutating call — not a
  live poll, same as the Hyperliquid adapter.

## Exact next step

Per this phase's stop condition: **do not implement live Trading212 trading, do not begin
autonomous execution, do not modify Hermes.** The next phase, when undertaken, would be either
(a) running the manual smoke test against real Trading212 Demo credentials to get the pending
real-network proof, or (b) the same next step identified at the end of the Hyperliquid Testnet
Adapter phase: wiring `ExecutionRunner` to optionally run the existing fixture-replay demo strategy
against an external broker (Hyperliquid or Trading212) instead of `LocalPaperBroker`, using the
broker factory both phases already built — while still stopping short of autonomous, unattended
operation.
