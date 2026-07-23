"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth/auth-context";
import { getSupabaseClient } from "@/lib/supabase/client";
import { SupabaseTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { approveTradeCandidate, rejectTradeCandidate } from "@/lib/hermes-execution/trade-approval/trade-candidate-service";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import type { TradeCandidate, TradeCandidateStatus } from "@/lib/hermes-execution/trade-approval/types";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { formatDateTime } from "@/lib/utils/format";

// Phase 3.5 — Trade Review & Approval. Reads and writes trade_candidates directly from the browser
// (anon-key Supabase client + the signed-in user's own id) — the same "safe to construct and use
// directly in the browser, protected by RLS" pattern SupabaseDecisionHistoryStore/
// SupabasePaperTradeStore already established (see supabase-decision-history-store.ts's own
// top-of-file comment). No bespoke server action or bearer-token plumbing exists here because none
// is needed: Postgres Row Level Security (auth.uid() = user_id, see
// supabase/migrations/0024_trade_candidates.sql) is the actual, database-enforced permission
// boundary — identical to every other per-user table in this schema.
//
// approveTradeCandidate/rejectTradeCandidate (trade-candidate-service.ts) are the SAME functions
// the standalone trading-runtime process itself uses — one shared implementation of "what counts as
// a valid approval/rejection" (expiry checks, atomic duplicate-safe transitions), not a second,
// parallel copy of that logic living in the UI. Their `auditTrail` parameter is satisfied with a
// throwaway InMemoryAuditTrail here — this process has no shared audit-log sink with the runtime
// process (a different machine/deployment), so that particular write goes nowhere useful; the
// TradeCandidate row's own approvedAt/approvedByUserId/rejectedAt/rejectionReason fields are this
// app's durable record of what happened (see this file's own history table below).

const REFRESH_INTERVAL_MS = 30_000;

const STATUS_FILTERS: readonly ("ALL" | TradeCandidateStatus)[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "EXECUTED",
  "FAILED",
  "ALL",
];

function statusBadgeClassName(status: TradeCandidateStatus): string {
  switch (status) {
    case "PENDING":
      return "border-accent-amber/30 bg-accent-amber/10 text-accent-amber";
    case "APPROVED":
      return "border-accent-blue/25 bg-accent-blue/10 text-accent-blue";
    case "EXECUTED":
      return "border-accent-teal/30 bg-accent-teal/10 text-accent-teal";
    case "REJECTED":
    case "FAILED":
      return "border-accent-red/30 bg-accent-red/10 text-accent-red";
    case "EXPIRED":
      return "border-base-600 bg-base-800 text-ink-400";
  }
}

function formatPrice(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 });
}

export function TradeApprovalView() {
  const { isConfigured, isLoading: authLoading, user } = useAuth();
  const [candidates, setCandidates] = useState<TradeCandidate[]>([]);
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("PENDING");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  const repository = useCallback(() => {
    const client = getSupabaseClient();
    if (!client || !user) return null;
    return new SupabaseTradeCandidateRepository(client, user.id);
  }, [user]);

  const refresh = useCallback(async () => {
    const repo = repository();
    if (!repo) return;
    setIsLoading(true);
    try {
      const result = await repo.list(statusFilter === "ALL" ? {} : { status: statusFilter });
      if (!isMounted.current) return;
      setCandidates(result);
      setError(null);
    } catch (err) {
      if (!isMounted.current) return;
      setError(err instanceof Error ? err.message : "Failed to load trade candidates.");
    } finally {
      if (isMounted.current) setIsLoading(false);
    }
  }, [repository, statusFilter]);

  // Mirrors DecisionIntelligenceView.tsx's own "define the async loader inline inside the effect"
  // pattern — calling the memoized `refresh` callback directly at an effect's top level trips
  // react-hooks/set-state-in-effect (an effect body must not synchronously invoke something that
  // sets state); an inline async function declared and invoked within the effect itself does not.
  // The interval effect below calls `refresh` safely because that call happens inside
  // setInterval's own deferred callback, never synchronously in the effect body.
  useEffect(() => {
    const repo = repository();
    if (!repo) return;

    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const result = await repo!.list(statusFilter === "ALL" ? {} : { status: statusFilter });
        if (cancelled) return;
        setCandidates(result);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load trade candidates.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    load();

    return () => {
      cancelled = true;
    };
  }, [repository, statusFilter]);

  useEffect(() => {
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleApprove = useCallback(
    async (candidateId: string) => {
      const repo = repository();
      if (!repo || !user) return;
      setPendingActionId(candidateId);
      try {
        const outcome = await approveTradeCandidate({
          repository: repo,
          auditTrail: new InMemoryAuditTrail(),
          executionRunId: "trade-approval-ui",
          candidateId,
          approvedByUserId: user.id,
          now: new Date(),
        });
        if (outcome.outcome === "expired") {
          setError("This candidate expired before it could be approved — its stale entry price is no longer valid.");
        } else if (outcome.outcome === "already-handled" || outcome.outcome === "not-found") {
          setError("This candidate was already handled (approved, rejected, or expired) — nothing to do.");
        }
        await refresh();
      } finally {
        if (isMounted.current) setPendingActionId(null);
      }
    },
    [repository, user, refresh],
  );

  const handleReject = useCallback(
    async (candidateId: string) => {
      const repo = repository();
      if (!repo || !user) return;
      setPendingActionId(candidateId);
      try {
        const outcome = await rejectTradeCandidate({
          repository: repo,
          auditTrail: new InMemoryAuditTrail(),
          executionRunId: "trade-approval-ui",
          candidateId,
          rejectedByUserId: user.id,
          now: new Date(),
        });
        if (outcome.outcome === "already-handled" || outcome.outcome === "not-found") {
          setError("This candidate was already handled — nothing to do.");
        }
        await refresh();
      } finally {
        if (isMounted.current) setPendingActionId(null);
      }
    },
    [repository, user, refresh],
  );

  if (!isConfigured) {
    return (
      <div className="panel p-6 text-sm text-ink-400" data-testid="not-configured-placeholder">
        Trade approval requires Supabase to be configured — it has nowhere durable to queue candidates in local
        prototype mode.
      </div>
    );
  }

  if (authLoading) {
    return <div className="panel p-6 text-sm text-ink-500">Checking your session…</div>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="panel flex flex-wrap items-center gap-3 px-4 py-3">
        <label className="flex items-center gap-2 text-xs text-ink-400">
          Status
          <select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as (typeof STATUS_FILTERS)[number])}
            className="rounded-lg border border-base-600 bg-base-900 px-2 py-1 text-xs text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            {STATUS_FILTERS.map((status) => (
              <option key={status} value={status}>
                {status === "ALL" ? "All" : status}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" onClick={() => void refresh()} disabled={isLoading}>
          {isLoading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error ? (
        <div className="panel border-accent-red/30 bg-accent-red/5 px-4 py-3 text-sm text-accent-red" role="alert">
          {error}
        </div>
      ) : null}

      <SectionPanel
        title={statusFilter === "PENDING" ? "Awaiting review" : "Trade candidates"}
        description={`${candidates.length} candidate${candidates.length === 1 ? "" : "s"} shown`}
      >
        {candidates.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500" data-testid="no-candidates-placeholder">
            {statusFilter === "PENDING"
              ? "No candidates awaiting review. Every BUY/SELL decision the trading runtime makes will appear here."
              : "No candidates match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto scrollbar-thin" role="region" aria-label="Trade candidates table, scroll horizontally for more columns" tabIndex={0}>
            <table className="w-full min-w-[1500px] text-left text-xs">
              <caption className="sr-only">Trade candidates awaiting or having received human review</caption>
              <thead>
                <tr className="border-b border-base-700/60 text-ink-500">
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 font-medium">Instrument</th>
                  <th scope="col" className="px-4 py-2 font-medium">Direction</th>
                  <th scope="col" className="px-4 py-2 font-medium">Strategy</th>
                  <th scope="col" className="px-4 py-2 font-medium">Confidence</th>
                  <th scope="col" className="px-4 py-2 font-medium">EMA20 / EMA50</th>
                  <th scope="col" className="px-4 py-2 font-medium">RSI14</th>
                  <th scope="col" className="px-4 py-2 font-medium">ATR14</th>
                  <th scope="col" className="px-4 py-2 font-medium">Trend</th>
                  <th scope="col" className="px-4 py-2 font-medium">Entry</th>
                  <th scope="col" className="px-4 py-2 font-medium">Stop loss</th>
                  <th scope="col" className="px-4 py-2 font-medium">Take profit</th>
                  <th scope="col" className="px-4 py-2 font-medium">Risk:Reward</th>
                  <th scope="col" className="px-4 py-2 font-medium">Reasoning</th>
                  <th scope="col" className="px-4 py-2 font-medium">Expires</th>
                  <th scope="col" className="px-4 py-2 font-medium">Created</th>
                  <th scope="col" className="px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-700/60">
                {candidates.map((candidate) => {
                  const context = candidate.execution.marketContext;
                  const isPending = candidate.status === "PENDING";
                  const isBusy = pendingActionId === candidate.id;
                  return (
                    <tr key={candidate.id} className="text-ink-300">
                      <td className="px-4 py-2">
                        <Badge className={statusBadgeClassName(candidate.status)}>{candidate.status}</Badge>
                      </td>
                      <td className="px-4 py-2 text-ink-100">{candidate.instrument}</td>
                      <td className="px-4 py-2">{candidate.direction}</td>
                      <td className="px-4 py-2">
                        {candidate.strategyId} v{candidate.strategyVersion}
                      </td>
                      <td className="px-4 py-2">{(candidate.confidence * 100).toFixed(0)}%</td>
                      <td className="px-4 py-2">
                        {formatPrice(context.ema20)} / {formatPrice(context.ema50)}
                      </td>
                      <td className="px-4 py-2">{context.rsi14.toFixed(1)}</td>
                      <td className="px-4 py-2">{context.atr14.toFixed(2)}</td>
                      <td className="px-4 py-2">{context.trend}</td>
                      <td className="px-4 py-2">{formatPrice(candidate.entryPrice)}</td>
                      <td className="px-4 py-2">{formatPrice(candidate.stopLoss)}</td>
                      <td className="px-4 py-2">{formatPrice(candidate.takeProfit)}</td>
                      <td className="px-4 py-2">1:{candidate.riskReward.toFixed(1)}</td>
                      <td className="max-w-xs px-4 py-2 text-ink-500">
                        <ul className="list-inside list-disc space-y-0.5">
                          {candidate.reasoning.map((line, index) => (
                            <li key={index}>{line}</li>
                          ))}
                        </ul>
                        {candidate.validationNotes.length > 0 ? (
                          <p className="mt-1 text-accent-amber">{candidate.validationNotes.join("; ")}</p>
                        ) : null}
                      </td>
                      <td className="px-4 py-2 text-ink-500">{formatDateTime(candidate.expiresAt)}</td>
                      <td className="px-4 py-2 text-ink-500">{formatDateTime(candidate.createdAt)}</td>
                      <td className="px-4 py-2">
                        {isPending ? (
                          <div className="flex gap-2">
                            <Button
                              variant="primary"
                              disabled={isBusy}
                              onClick={() => void handleApprove(candidate.id)}
                              data-testid={`approve-${candidate.id}`}
                            >
                              Approve
                            </Button>
                            <Button
                              variant="danger"
                              disabled={isBusy}
                              onClick={() => void handleReject(candidate.id)}
                              data-testid={`reject-${candidate.id}`}
                            >
                              Reject
                            </Button>
                          </div>
                        ) : (
                          <span className="text-ink-500">
                            {candidate.status === "REJECTED" && candidate.rejectionReason ? candidate.rejectionReason : "—"}
                            {candidate.status === "FAILED" && candidate.failureReason ? candidate.failureReason : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>

      <InfoNote>
        Approving a candidate does not execute it immediately — it queues the candidate for the trading runtime&apos;s
        next cycle, which re-checks portfolio risk against the account&apos;s current state before placing the order
        (state can change between review and execution). Automatic execution is off unconditionally: nothing on this
        page, or anywhere else, causes a trade without an explicit Approve here first. A candidate whose review
        window (expiresAt) passes before it is approved — or approved but not yet executed — is marked EXPIRED
        rather than acted on at a stale price.
      </InfoNote>
    </div>
  );
}
