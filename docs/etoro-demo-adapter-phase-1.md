# eToro Demo Adapter — Phase 1

Adds eToro's official Public API as a fourth broker behind the same `PaperBroker` interface
Execution MVP Phase 1 defined — a third external-venue proof (after Hyperliquid's testnet perp
exchange and Trading212's equities broker), this time a CFD/social-trading broker with a notional-
amount, leverage-based position model rather than a share- or unit-count one.

**`LocalPaperBroker` remains the default and unmodified.** Hyperliquid and Trading212 are untouched.
The execution engine, signal engine, risk engine, and audit event shapes are all unchanged. This
phase adds a fourth broker implementation and a way to select it, without touching anything
upstream of the broker interface.

## Architecture

```
Execution Engine (unchanged)
        │
        ▼
Broker Interface (PaperBroker — unchanged, no new methods added)
        │
        ├── LocalPaperBroker            (Execution MVP Phase 1 — still the default)
        ├── HyperliquidTestnetBroker    (Hyperliquid Testnet Adapter phase)
        ├── Trading212DemoBroker        (Trading212 Demo Adapter phase)
        └── EtoroDemoBroker             (this phase)
                │
                ▼
        eToro Public API (public-api.etoro.com — demo-only paths, never a live-money route)
```

### New files

```
src/lib/hermes-execution/
├── broker-factory.ts                  Extended: getBroker() now has a fourth branch
├── config.ts                          Extended: EtoroDemoConfig + ETORO_* env parsing
├── types.ts                           Extended: 3 new audit event types (see below)
└── etoro/
    ├── etoro-client.ts                Minimal fetch-based HTTP client + external DTOs (no new dependency)
    └── etoro-demo-broker.ts           EtoroDemoBroker + its adapter-specific error types

src/hermes-execution/
└── broker-etoro-smoke.ts              CLI entrypoint (`npm run broker:etoro-smoke`)

tests/hermes-execution/
├── broker-factory.test.ts             Extended with eToro branch coverage
└── etoro/
    ├── config-etoro.test.ts
    ├── etoro-client.test.ts
    └── etoro-demo-broker.test.ts      Mocked at the global `fetch` boundary
```

## Why no new dependency

eToro publishes no official Node/TypeScript SDK. `etoro-client.ts` is a plain `fetch` wrapper, same
convention as `trading212-client.ts` — no HTTP library, no eToro SDK, and explicitly none of the
unofficial community wrappers found during research (see "Documentation / live-response
discrepancies" below for why those were deliberately not used even as a schema reference).

## Authentication

Every request carries three headers:

- `x-api-key` — eToro API key
- `x-user-key` — eToro user key
- `x-request-id` — a fresh UUID (via Node's `crypto.randomUUID()`) on **every** request, never
  reused

Neither key is ever logged, and no code path prints a full headers object — `EtoroClient` builds
the headers object inline per request and only ever surfaces individual safe fields (never the
headers themselves) on a thrown `EtoroApiError`.

## Official endpoints used

| Purpose | Method | Path | Confidence |
|---|---|---|---|
| Credential/session verification + demo portfolio | GET | `/api/v1/trading/info/demo/portfolio` | Confirmed |
| Instrument search/resolution | GET | `/api/v1/market-data/search` | Confirmed |
| Current rate (bid/ask) | GET | `/api/v1/market-data/instruments/rates` | Confirmed |
| Open a demo market order | POST | `/api/v2/trading/execution/demo/orders` | Confirmed (given verbatim in this phase's brief, corroborated independently) |
| Close a demo position (full) | POST | `/api/v1/trading/execution/demo/market-close-orders/positions/{positionId}` | **Inferred, not independently confirmed** — see discrepancies below |
| Cancel a pending demo close order | DELETE | `/api/v1/trading/execution/demo/market-close-orders/{orderId}` | **Inferred, not independently confirmed** — see discrepancies below |

There is no `/api/v2/trading/execution/orders` (real) call anywhere in this codebase, and no
`/api/v1/trading/info/portfolio` (real) call either — every trading-related path this adapter can
reach structurally contains `/demo/`.

## Environment variables

| Variable | Required when | Default | Notes |
|---|---|---|---|
| `ETORO_ENV` | `BROKER_PROVIDER=etoro-demo` | none | Must be exactly `"demo"` if set at all, regardless of active provider — an unset value is a distinct "not configured" state, never inferred as `"demo"` |
| `ETORO_API_KEY` | `BROKER_PROVIDER=etoro-demo` | none | Never logged/committed |
| `ETORO_USER_KEY` | `BROKER_PROVIDER=etoro-demo` | none | Never logged/committed |
| `ETORO_DEMO_TEST_INSTRUMENT` | optional | `"BTC"` | A search term, resolved at runtime — never a hard-coded `instrumentId` |
| `ETORO_DEMO_TEST_AMOUNT` | `BROKER_PROVIDER=etoro-demo` | **none** | See below |

`ETORO_DEMO_TEST_AMOUNT` has no default anywhere in this codebase. eToro's documentation exposes no
confirmed minimum-order-size signal (no `minTradeQuantity`-equivalent field was found on any
instrument or metadata endpoint) to derive a safe default from — unlike Trading212's
`TRADING212_DEMO_TEST_QUANTITY`, which does have a documented-safe default (1 share). Per this
phase's own instruction ("if minimum order size ... cannot be confirmed, require it explicitly
rather than guessing"), config-build fails closed with a clear `ConfigError` whenever
`BROKER_PROVIDER=etoro-demo` and this is unset.

`BROKER_PROVIDER=etoro-demo` is the fourth (still non-default) value in `SUPPORTED_BROKER_PROVIDERS`
— there is no `"etoro-live"` or `"etoro"` value anywhere in the type, exactly like the other three
providers' own "no live value exists structurally" pattern.

## Demo-only safeguards

- **Two independent gates**, both required: `BROKER_PROVIDER=etoro-demo` selects the adapter;
  `ETORO_ENV=demo` is a second, separate value the broker factory and `EtoroDemoBroker`'s own
  constructor both check before ever constructing it. Neither alone is sufficient. This plays the
  same role Hyperliquid's/Trading212's `_EXECUTION_ENABLED=true` flags play — an explicit second
  confirmation, just spelled as an environment name instead of a boolean.
- **`ETORO_ENV` can only ever be `"demo"`.** Its TypeScript type (`EtoroEnv`) has exactly one legal
  value; there is no `"live"` or `"real"` variant declared anywhere for it to accidentally become.
  Config-build fails closed the moment it's set to anything else, regardless of which broker
  provider is active — defense in depth, not just a check gated behind `etoro-demo` being selected.
- **Never inferred from missing configuration.** An unset `ETORO_ENV` is a distinct "not configured"
  state (`undefined`), never silently treated as `"demo"`.
- **Structural, not just conventional, demo-only routing.** `EtoroClient`'s trading methods
  (`placeDemoMarketOrder`, `closeDemoPosition`, `cancelPendingCloseOrder`) each hard-code a path
  containing the literal segment `/demo/` — there is no parameter, config value, or code path that
  can make any of them target a real-money route. `getDemoPortfolio()` is likewise hard-coded to the
  `/demo/` variant; the real `/api/v1/trading/info/portfolio` path is never called anywhere in this
  adapter.
- **Never submits NaN/Infinity/zero/negative amounts.** `EtoroDemoBroker` validates the order amount
  with `Number.isFinite(amount) && amount > 0` before ever calling `EtoroClient`, in both
  `placeMarketOrder` and `closePosition` — mirroring Trading212DemoBroker's identical guard.
- **Never submits an order for an unresolved instrument.** `placeMarketOrder` throws immediately if
  `order.instrument` was never passed through `resolveInstrument()` (eToro's own market-data search),
  refusing any caller-supplied or guessed `instrumentId`.
- **Secrets never logged.** Neither `ETORO_API_KEY` nor `ETORO_USER_KEY` appears in any audit event,
  log line, or thrown error message (asserted directly in `etoro-client.test.ts` and
  `etoro-demo-broker.test.ts`). `.env.local` is `.gitignore`d; `.env.example` holds placeholders only.
- **No full header dumps.** `EtoroApiError` surfaces `operation`, `status`, `requestId`,
  `brokerErrorCode`, and a `safeMessage` extracted from a small known set of message-like fields —
  never a raw headers object, never a blind `JSON.stringify` of an error body.

## DTO-to-domain mapping

`etoro-client.ts` declares every eToro-facing shape (`EtoroInstrumentSearchResult`, `EtoroRate`,
`EtoroPosition`, `EtoroPendingOrder`, `EtoroDemoPortfolio`, `EtoroOrderExecutionResult`,
`EtoroConfirmationResult`) — nothing outside `src/lib/hermes-execution/etoro/` ever sees one of
these. `etoro-demo-broker.ts` is the only place a raw eToro DTO is translated into `OrderRequest` /
`PaperPosition` / `CompletedTrade` (the shared execution-domain types every broker adapter targets).

The one mapping decision worth calling out: **eToro trades CFD notional "amount," not a share/unit
count.** `OrderRequest.quantity` / `PaperPosition.quantity` are reused to carry this amount (same
field, different meaning than Trading212/Hyperliquid's share/unit counts) — and realised P/L is
computed as **a percentage return on that notional**:

```
realisedPnl = amount × ((exitPrice − entryPrice) / entryPrice) × direction
```

— not `(exitPrice − entryPrice) × quantity × direction`, the formula Trading212/Hyperliquid use for
their unit-count-based positions. Reusing that formula here would silently produce a nonsense P/L
number (it would conflate a dollar amount with a unit count). `entryPrice` prefers the position's own
`openRate` (as reported back by the demo-portfolio re-fetch) and falls back to the smoke test's own
pre-order rate quote if `openRate` is absent from the response.

## Smoke-test lifecycle (`npm run broker:etoro-smoke`)

1. Validate demo-only configuration (provider, `ETORO_ENV=demo`, both keys, non-empty instrument
   search term, a positive finite test amount).
2. Authenticate (via `connect()`, which reads the demo portfolio as its credential check — see
   "known API limitations" below for why there's no separate verification call).
3. Print the demo portfolio/account snapshot (positions/orders tracked, plus a best-effort "credit"
   read — see limitations).
4. Resolve `ETORO_DEMO_TEST_INSTRUMENT` through eToro's own market-data search. Prints the resolved
   display name, symbol, and numeric `instrumentId` **before** anything is submitted.
5. Retrieve a current bid/ask for the resolved instrument.
6. Display the proposed amount, currency, and fixed leverage (1 — never configurable, never
   leveraged) before submitting anything.
7. Submit one small DEMO market BUY order.
8. Reconcile the resulting order into a specific position — by re-fetching the demo portfolio and
   matching on the order response's own `positionId` (never by instrument alone; see "Instrument
   resolution" requirements in the phase brief).
9. Independently re-confirm that exact position is present via `getOpenPositions()`.
10. Close that exact position completely (a fresh rate is fetched first and used as the exit price,
    since eToro's close confirmation carries no fill price of its own).
11. Confirm it is no longer open.
12. Report the final outcome and exit with its corresponding code.

The test only ever operates on the position its own order response identified — it never scans the
portfolio for "a position on this instrument" and acts on whatever it finds, so it cannot interfere
with a pre-existing manual eToro position on the same instrument.

## Outcomes and exit codes

| Outcome | Exit code | Meaning |
|---|---|---|
| `PASSED` | 0 | Connected, instrument resolved, order accepted, the resulting position was identified, closed, and closure confirmed. |
| `FAILED` | 1 | A genuine failure — bad config, connection failure, no/ambiguous instrument match, an order rejected outright, or a `positionId` eToro itself returned that couldn't be found in the re-fetched portfolio. |
| `INCONCLUSIVE_MARKET_CLOSED` | 2 | No rate data was available for the resolved instrument. eToro's API exposes no confirmed dedicated market-status field (see limitations) — this is a best-effort interpretation of absent pricing, not a certain diagnosis. |
| `INCONCLUSIVE_API_LIMITATION` | 3 | The order was accepted but eToro's response contained none of `orderId`/`positionId`/`token`/`requestToken` — a documented gap in what this adapter can verify, not evidence the trade itself failed. |
| `CLEANUP_REQUIRED` | 4 | An order or position may still be active and the script cannot safely confirm cleanup (e.g. the close call was submitted but the position still appears open afterward, or any exception occurs during the close/re-verify stage). |

`FAILED` and `INCONCLUSIVE_API_LIMITATION` are deliberately kept distinct: the former means "this
adapter looked for what it expected and didn't find it" (a concrete mismatch); the latter means "this
adapter structurally cannot verify, because eToro's response didn't include enough information to
try" (a documentation/response-shape gap, not a disproof of the trade).

## Cleanup behaviour

- **Order accepted and reconciled, then closed cleanly** → `PASSED`; the smoke test's own
  post-close check confirms nothing remains tracked.
- **Order accepted but reconciliation fails** (`EtoroReconciliationError`) → nothing was tracked as
  open by this broker instance, so there is nothing to clean up locally — but a real eToro position
  may still exist. The outcome (`FAILED` for `"not-found"`, `INCONCLUSIVE_API_LIMITATION` for
  `"no-identifier"`) is reported with enough detail (the raw identifiers eToro did return) for manual
  follow-up in the eToro UI.
- **Close submitted but the position still appears open afterward, or any error occurs while
  closing/re-verifying** → `CLEANUP_REQUIRED`. This is deliberately the outcome for *any* exception
  in that stage, not just the specific "still open" case — once an order has been accepted, this
  adapter treats itself as responsible for it, and reports uncertainty rather than guessing at
  success.
- **No automatic pending-order cancellation is wired into the smoke test.** `EtoroClient.
  cancelPendingCloseOrder()` exists (per this phase's requirement to implement "pending-order
  cancellation, if supported"), but is never called automatically — see the next section for why.

## Known API limitations

- **No confirmed "get order/position by id" endpoint.** Reconciliation works by re-fetching the
  whole demo portfolio and matching on the identifier the order response returned, rather than
  polling a dedicated status endpoint (none was found to exist, documented or otherwise).
- **No confirmed cancellation path for a pending *open* order.** The only documented cancellation
  endpoint is scoped to a pending *close* order specifically (`cancel-pending-close-order`); nothing
  equivalent for a pending open was found. A stuck pending open therefore surfaces as
  `CLEANUP_REQUIRED`, not an automatic cancel attempt.
- **No confirmed dedicated market-status/tradability field.** Unlike Trading212 (whose
  `GET /equity/metadata/exchanges` gives an exact OPEN/CLOSE schedule — see
  `docs/trading212-demo-adapter-phase-1.md`), no equivalent was confirmed for eToro. Absent rate
  data is interpreted as "market closed or pricing unavailable" on a best-effort basis only.
- **No confirmed close-fill price.** eToro's close confirmation is modeled as a bare token
  (`EtoroConfirmationResult`); the smoke test re-fetches a rate itself immediately before closing and
  uses that as the exit price, the same way `LocalPaperBroker.closePosition()` takes its exit price
  as a caller-supplied parameter rather than deriving one internally.
- **Demo account balance field name unconfirmed.** eToro's own product terminology calls demo/virtual
  funds "Credit," but the exact API field name backing that concept was not independently confirmed;
  `getAccount()` returns a best-effort value (0 if absent) with the smoke test printing an explicit
  caveat rather than silently presenting an unconfirmed number as fact. This value is display-only —
  it is never used to size an order (that's `ETORO_DEMO_TEST_AMOUNT`, an explicit config value).

## Documentation / live-response discrepancies

**No eToro API credentials were available while building this phase** (see `.env.local` — no
`ETORO_*` values are present). Every endpoint and DTO above comes from eToro's official documentation
(`api-portal.etoro.com`, `builders.etoro.com`), fetched and summarized through an automated tool
rather than read as raw HTML/OpenAPI JSON. That process itself surfaced inconsistencies worth
recording:

1. **v1/v2 version mixing, exactly as this phase's brief warned.** Instrument search and the
   close-order family remain under `/api/v1/...`; opening a position moved to a "unified"
   `/api/v2/trading/execution/orders` (`/demo/orders` for demo) — confirmed by this phase's own brief
   and corroborated independently. An older guide page still shows a different v1 open-order shape;
   it was explicitly not used.
2. **Field-casing inconsistency across independent fetches of the same documentation.** Different
   fetches of rate/instrument-search pages returned `instrumentId` vs `instrumentID`, and
   `displayName` vs `displayname`, for what is presumably the same field. `camelCase` (`instrumentId`,
   `displayName`) was chosen because it's verbatim in the v2 order-body examples found (highest
   confidence source); the alternate casings are noted here in case a live response disagrees.
3. **The demo-close and demo-cancel paths are inferred, not confirmed.** Only the real-money variants
   (`/api/v1/trading/execution/market-close-orders/positions/{positionId}` and
   `/api/v1/trading/execution/market-close-orders/{orderId}`, the latter's only confirmed OAuth2
   scope being `etoro-public:real:write`) were directly documented. The `/demo/` segment used by this
   adapter's `closeDemoPosition`/`cancelPendingCloseOrder` is inferred by the same pattern every other
   confirmed demo/real pair follows (`.../info/portfolio` vs `.../info/demo/portfolio`;
   `/api/v2/.../orders` vs `/api/v2/.../demo/orders`). Because the path is hard-coded to contain
   `/demo/`, the worst case if this inference is wrong is a 404 (a safe, visible failure) — never an
   accidental call to the confirmed real-money endpoint.
4. **An unofficial, third-party eToro API wrapper surfaced in research was deliberately not used** as
   a schema reference, per this phase's explicit exclusion of unofficial wrappers — even though it
   showed a differently-shaped order response (`requestToken`, `positionID`, `isBuy`, `openRate`,
   etc.) that might have resolved some of the ambiguities above. `EtoroOrderExecutionResult`'s
   all-optional, multi-field-name design exists specifically to tolerate this kind of uncertainty
   without guessing wrong.

**Before trusting any of this in anything beyond mocked tests, run the live smoke test with real
credentials and reconcile any mismatch against this document.**

## Exact setup and run commands

1. Create an eToro account (a demo/practice account is sufficient — no real-money account is
   required for this phase).
2. Sign in at `https://api-portal.etoro.com`.
3. Navigate to **Settings → Trading → API Key Management**.
4. Create a new key. Record both the **API key** and the **User key** immediately — copy them into
   `.env.local` (never into any committed file):

   ```
   BROKER_PROVIDER=etoro-demo
   ETORO_ENV=demo
   ETORO_API_KEY=<your API key>
   ETORO_USER_KEY=<your user key>
   ETORO_DEMO_TEST_INSTRUMENT=BTC
   ETORO_DEMO_TEST_AMOUNT=50
   ```

5. Run the smoke test:

   ```
   npm run broker:etoro-smoke
   ```

6. Read the final `ETORO SMOKE TEST OUTCOME:` line and its exit code (see the outcomes table above).
