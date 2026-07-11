# Build 1.12.0 — Operations Centre & UX Polish

Date: 2026-07-10
Location: `Trading/platform/web`

## What this build is, and isn't

The underlying architecture (Strategy Engine, Position Protection, Portfolio Risk Manager, Decision
History, VPS Worker, Alpha Vantage/Finnhub market data, Supabase) had grown well ahead of the
interface presenting it — a Dashboard cluttered with scheduler configuration, a System Health page
that read like a technical changelog, and copy that talked about missions, npm commands, and
"persistence layers" instead of what the platform actually does for a trading user.

This build is pure UX, terminology, and information-architecture work. **No trading algorithm, risk
rule, strategy calculation, database schema, or worker behaviour changed.** Every number on every
new panel is read from the exact same functions and hooks the app already used — see each
component's own comments for which one.

## 1. Redesigned Dashboard

Rebuilt around one question: "what is my AI doing right now?" Five sections replace the old
scheduler-heavy layout:

- **Portfolio overview** — Portfolio value, Cash available, Open positions, Today's P/L. Cash
  available and open positions are read from `buildExposureSnapshot(trades)`, the exact same pure
  function the AI Engine's own risk checks use — not a new calculation.
- **AI activity** — Automatic scanning (on/off, combining both scheduling systems), AI decisions
  today, Last scan (this browser), Next scan (this browser).
- **Recent AI decisions** — the five most recent scans from this browser's decision log, with a
  link to the full history.
- **Market overview** — market status, a watchlist snapshot, and a one-line live-prices indicator.
- **Quick actions** — a "Run scan now" button plus links to Settings, Paper Portfolio, Trade
  Journal, and the Operations Centre.

All scheduler configuration (mode, interval, start/stop) moved to Settings — the Dashboard no
longer lets you configure anything, only observe and trigger a scan.

## 2. New Settings page (`/settings`)

Every piece of operational configuration that used to live on the Dashboard now lives here:

- **Automatic scanning** — "This browser" (frequency, start/stop) and "Server (always-on)"
  (enable/disable, interval), side by side, both clearly labelled as independent systems.
- **Market data** — which live-price and historical-data providers are configured, framed as
  configuration, not health (health lives on the Operations Centre).
- **Broker connection** — an honest "Coming soon" placeholder. No fake toggle.

### Architecture note: automatic scanning is now app-wide

Previously, the actual tick that fired a scheduled scan lived inside the Dashboard's own
`BotRunnerPanel` component — the browser-based schedule silently paused if you navigated away from
the Dashboard. That logic is now a small headless component, `AutomationRunner`
(`src/components/automation/AutomationRunner.tsx`), mounted once in `AppShell` alongside the other
app-wide providers. The scan logic itself (`useBotScanRunner`, extracted verbatim from the old
panel) is unchanged; only *where* the timer lives changed. Verified live: automatic scanning started
on Settings correctly kept advancing after navigating to the Dashboard and to the Operations Centre.

## 3. Redesigned Operations Centre (formerly System Health, route unchanged: `/system-health`)

Replaced a flat list of panels with a top health verdict and seven grouped sections:

- **Platform health overview** — four KPI cards (Platform health %, Market status, Database,
  Always-on scanning) plus an issues list when anything needs attention. The percentage
  (`summarizePlatformHealth`, `src/lib/utils/platform-health.ts`) is a presentation rollup of
  existing status flags (database, live prices, historical data, AI decision history, always-on
  scanning) — not a new business calculation.
- **Market Data** — live prices and historical market data, combined.
- **AI Engine** — strategy calculations, recent scan activity, and the two safety layers
  (Portfolio Risk Manager, Position Protection), each condensed to one line per limit group instead
  of one row per number.
- **VPS Worker** — always-on scanning status, renamed from "Server Scheduler."
  ​
- **Database** — storage and account sign-in, combined (renamed from "Persistence").
- **Trading Mode** — replaces the old static "Services" list (`Broker API: Not Connected`,
  `Execution Engine: Disabled` — hardcoded mock data that never reflected reality) with an honest,
  positively-framed read of the platform's actual current mode: Paper trading **Enabled**, Live
  trading **Not enabled**, Broker connection **Coming soon**.
- **AI Decision History** — renamed from "Decision Intelligence."

Every status here reads live application state. Verified live in local mode: Platform health 100%,
Database Connected, Always-on scanning correctly reported "Unavailable" (no database configured),
and — after running a manual scan — AI Decision History correctly showed 1 decision recorded.

## 4. Terminology sweep

Replaced developer/internal wording with plain trading language across every page, banner, modal,
and status panel:

| Before | After |
|---|---|
| Persistence | Database |
| Scheduler | Automatic Scanning |
| Historical Provider | Historical Market Data |
| Decision Intelligence | AI Decision History |
| Position Manager | Position Protection |
| Bot Runner (in copy) | AI Engine |
| "Execution Engine: Disabled" | "Paper Trading: Enabled" |
| Supabase (in copy) | "your database" / "Database" |
| "Prototype mode" / "prototype paper trading" | "Paper trading only" |

Also fixed a real accuracy bug found during this pass: the Bot Decisions page's disclosure still
said "there is no scheduled or autonomous triggering in this build" — stale copy left over from
before Mission 4 added scheduling. It now correctly describes both the manual and automatic paths.

## 5. Removed prototype wording and dead code

- Removed "Prototype workspace" / "Prototype mode" copy from the sidebar, banner, and page metadata.
- Removed all Mission-number references from user-visible copy (footer, sidebar, page headers,
  info notes). Mission numbers remain only in source comments and `docs/product/` history, where
  they're accurate engineering record, not user-facing claims.
- Removed the static `systemServices` mock array and `SystemHealthList` component — this was
  hardcoded data that always reported "Database: Not Connected" and "Execution Engine: Disabled"
  regardless of actual configuration, the exact inaccuracy this build's requirement 6 called out.
  Replaced by `TradingModeStatusPanel`, which reads no external state because there's nothing to
  read — trading mode is a fixed fact about this build, stated plainly instead of implied through a
  fake service list.
- Removed `ServiceState`/`SystemService` types and `serviceStateClasses`/`serviceStateLabel` style
  helpers — no longer referenced by anything.
- Removed npm command references (`npm run worker`) and internal log-line names
  (`historical_data_status`) from user-visible panel copy.

## 6. Navigation

- Added **Settings** to the sidebar (new gear icon).
- Renamed **System Health** → **Operations Centre** in the sidebar (route unchanged).
- Renamed **Decision Intelligence** → **AI Decision History** in the sidebar (route unchanged).

## Files changed

New:
- `src/app/settings/page.tsx`
- `src/components/automation/AutomationRunner.tsx`
- `src/components/settings/BrowserAutomationPanel.tsx`, `ServerAutomationPanel.tsx`,
  `MarketDataSettingsPanel.tsx`, `BrokerSettingsPanel.tsx`
- `src/components/dashboard/PortfolioOverviewKpis.tsx`, `AIActivityKpis.tsx`,
  `RecentAIDecisionsList.tsx`, `QuickActionsPanel.tsx`, `MarketOverviewSummary.tsx`
- `src/components/system-health/PlatformHealthOverview.tsx`, `DatabaseStatusPanel.tsx`,
  `AIEngineActivityPanel.tsx`, `VPSWorkerStatusPanel.tsx`, `AIDecisionHistoryStatusPanel.tsx`,
  `TradingModeStatusPanel.tsx`
- `src/lib/state/use-bot-scan-runner.ts`
- `src/lib/utils/platform-health.ts`

Deleted:
- `src/components/dashboard/BotRunnerPanel.tsx`, `ServerSchedulePanel.tsx`,
  `PaperTradingSummary.tsx`, `IntelligenceSummaryCard.tsx`, `MarketDataStatusCard.tsx`,
  `StrategyEngineSummaryCard.tsx`
- `src/components/system-health/PersistenceStatusPanel.tsx`, `BotRunnerStatusPanel.tsx`,
  `ServerSchedulerStatusPanel.tsx`, `DecisionIntelligenceStatusPanel.tsx`
- `src/components/tables/SystemHealthList.tsx`

Changed (redesign or terminology pass): `src/app/page.tsx`, `src/app/system-health/page.tsx`,
`src/app/bot-decisions/page.tsx`, `src/app/not-found.tsx`, `src/app/layout.tsx`,
`src/components/layout/{Sidebar,Footer,AppShell,PrototypeBanner,PersistenceFallbackBanner}.tsx`,
`src/components/layout/nav-items.ts`, `src/components/icons.tsx`,
`src/components/decision-intelligence/DecisionIntelligenceView.tsx`,
`src/components/bot/BotDecisionsView.tsx`, `src/components/trading/{PaperTradeModal,
CloseTradeModal,ImportHistoryModal,TradeJournalView}.tsx`,
`src/components/system-health/{MarketDataStatusPanel,HistoricalDataStatusPanel,
AuthStatusPanel,StrategyEngineStatusPanel}.tsx`, `src/lib/mock/system-health.ts`,
`src/lib/types/system-health.ts`, `src/lib/utils/style.ts`.

No database migration — this build touches no Supabase table or schema.

## Verification

`npm run lint`, `npm run build`, `npx tsc --noEmit` — all clean throughout, including after every
major edit batch (component extraction, page rewrites, terminology sweep).

**Live browser verification** (local prototype mode, `.env.local` moved aside): confirmed no
console errors on Dashboard, Settings, or the Operations Centre; ran a manual scan from the
Dashboard's "Run scan now" button and confirmed AI Activity, Recent AI Decisions, Bot Decisions, and
AI Decision History all updated correctly with the real result; started automatic scanning from
Settings and confirmed it correctly showed "Running" with a computed next-scan time, then confirmed
the same state was still correctly reflected on the Dashboard after navigating away and back —
proof the app-wide `AutomationRunner` keeps the schedule alive independent of which page is open;
confirmed the Operations Centre's Platform Health showed 100% with all groups reporting accurately
for local mode (Database Connected, Always-on scanning Unavailable, one AI decision recorded after
the test scan).

## Readiness verdict

**Ready.** The Dashboard, Settings, and Operations Centre are fully rebuilt and live-verified; every
existing feature remains reachable (nothing was removed, only relocated or reworded); no business
logic, risk rule, or database schema changed.

## Suggested next build

With the interface now describing the platform honestly, natural next steps: connect a real broker
sandbox behind the Settings placeholder; make the Operations Centre's Platform Health check
reachable via a lightweight API route so it can reflect the VPS worker's real Alpha Vantage status
directly, not just via disclosure text; or a mobile-responsive pass now that the information
architecture is settled.
