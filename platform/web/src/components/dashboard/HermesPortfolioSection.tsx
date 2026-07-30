"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { StatCard } from "@/components/ui/StatCard";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { useHermesDashboardData } from "@/lib/hermes-dashboard/use-hermes-dashboard-data";
import { formatMaybeBrokerAmount } from "@/lib/hermes-dashboard/format";
import { formatDateTime, formatRelativeTime } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";
import { HermesPositionsTable } from "./HermesPositionsTable";
import { HermesRuntimeStatusStrip } from "./HermesRuntimeStatusStrip";

// Main Dashboard Hermes/eToro fix — the primary objective: the main Dashboard now represents the
// Hermes/eToro demo account, accurately and clearly, instead of the legacy local paper portfolio.
// Every figure below is read from GET /api/hermes/portfolio / /positions / /summary (via
// use-hermes-dashboard-data.ts) — never from paper-trades-context/local-storage-paper-trade-store.
// On any Hermes failure, this section shows an explicit error/unauthorised state and keeps
// whatever it last successfully loaded (clearly marked stale) — it never silently falls back to
// the legacy local paper figures, which would mix two different account models and mislead the
// user about what money is actually at risk.

export function HermesPortfolioSection() {
  const { state, portfolio, positions, summary, lastRefreshedAt, isStale, refresh } = useHermesDashboardData();

  return (
    <SectionPanel
      title="eToro Demo Portfolio"
      description="Broker ground truth — read live from the Hermes runtime's connected eToro demo account"
    >
      <div className="flex flex-col gap-4 px-5 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500" data-testid="hermes-provenance">
            <Badge className="border-accent-teal/30 bg-accent-teal/10 text-accent-teal" data-testid="hermes-ground-truth-badge">
              Broker ground truth
            </Badge>
            {portfolio ? (
              <>
                <span>
                  Provider: <span className="text-ink-300">{portfolio.provider}</span>
                </span>
                <span>&middot;</span>
                <span>
                  Account mode: <span className="text-ink-300">{portfolio.accountMode}</span>
                </span>
              </>
            ) : null}
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-500">
            <span data-testid="hermes-last-refreshed">
              {lastRefreshedAt ? `Last refreshed ${formatRelativeTime(lastRefreshedAt)}` : "Not yet refreshed"}
            </span>
            <Button variant="secondary" onClick={refresh} data-testid="hermes-refresh-button">
              Refresh
            </Button>
          </div>
        </div>

        {isStale && state.status === "ready" ? (
          <div
            className="rounded-lg border border-accent-amber/30 bg-accent-amber/10 px-4 py-2 text-xs text-accent-amber"
            data-testid="hermes-stale-warning"
          >
            This data may be out of date — the last successful refresh was {lastRefreshedAt ? formatRelativeTime(lastRefreshedAt) : "a while ago"}
            . Broker-connected data should refresh automatically every 30 seconds.
          </div>
        ) : null}

        {state.status === "loading" ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" data-testid="hermes-loading">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <div key={index} className="panel h-24 animate-pulse bg-base-800/60" />
            ))}
          </div>
        ) : null}

        {state.status === "unauthorized" ? (
          <div
            className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red"
            data-testid="hermes-unauthorized"
          >
            Unauthorised: {state.message} The Hermes Integration API may not be configured on this deployment.
          </div>
        ) : null}

        {state.status === "error" ? (
          <div className="rounded-lg border border-accent-red/30 bg-accent-red/10 px-4 py-3 text-sm text-accent-red" data-testid="hermes-error">
            Could not load the eToro demo portfolio: {state.message}
          </div>
        ) : null}

        {state.status === "ready" && portfolio ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="hermes-portfolio-kpis">
              <StatCard label="Broker cash" value={formatMaybeBrokerAmount(portfolio.cash)} />
              <StatCard label="Invested value" value={formatMaybeBrokerAmount(portfolio.investedValue)} />
              <StatCard label="Open positions" value={String(portfolio.openPositionCount)} />
              <StatCard
                label="Realised P/L"
                value={formatMaybeBrokerAmount(portfolio.realisedPnl)}
                valueClassName={portfolio.realisedPnl !== null ? plToneClass(portfolio.realisedPnl) : undefined}
                sublabel={
                  portfolio.unreconciledClosedTradeCount > 0
                    ? `${portfolio.realisedPnlScope} — ${portfolio.unreconciledClosedTradeCount} closed trade(s) excluded (unreconciled, exit price unknown)`
                    : portfolio.realisedPnlScope
                }
              />
              {/* Requirement 6: an amount only when the total is genuinely COMPLETE — "Unavailable"
                  plus its reason otherwise, never a silently-partial sum presented as whole. */}
              <StatCard
                label="Unrealised P/L"
                value={portfolio.unrealisedPnlComplete ? formatMaybeBrokerAmount(portfolio.unrealisedPnl) : "Unavailable"}
                valueClassName={
                  portfolio.unrealisedPnlComplete && portfolio.unrealisedPnl !== null ? plToneClass(portfolio.unrealisedPnl) : undefined
                }
                sublabel={!portfolio.unrealisedPnlComplete ? (portfolio.unrealisedPnlUnavailableReason ?? undefined) : undefined}
              />
              {/* Requirement 3/6: equity is either genuinely broker-supplied, internally calculated
                  (clearly labelled "Calculated equity" — never presented as if the broker supplied
                  it), or unavailable — never invented, never mislabelled. */}
              {portfolio.equitySource === "BROKER" ? (
                <StatCard label="Equity" value={formatMaybeBrokerAmount(portfolio.equity)} />
              ) : portfolio.equitySource === "CALCULATED" ? (
                <StatCard
                  label="Calculated equity"
                  value={formatMaybeBrokerAmount(portfolio.equity)}
                  sublabel="Cash + invested value + unrealised P/L"
                />
              ) : (
                <StatCard label="Equity" value="Unavailable" sublabel="Requires a complete unrealised P/L" />
              )}
            </div>

            <div className="flex flex-col gap-1 text-xs text-ink-500">
              <span>As of {formatDateTime(portfolio.timestamp)}</span>
              {!portfolio.positionsAreLiveGroundTruth ? (
                <span className="text-accent-amber">
                  This broker has no live ground-truth portfolio read — figures reflect only this process&apos;s own tracked positions.
                </span>
              ) : null}
            </div>

            <HermesRuntimeStatusStrip summary={summary} />
          </>
        ) : null}
      </div>

      {state.status === "ready" && positions ? (
        <div className="pt-2">
          <HermesPositionsTable positions={positions.positions} />
        </div>
      ) : null}
    </SectionPanel>
  );
}
