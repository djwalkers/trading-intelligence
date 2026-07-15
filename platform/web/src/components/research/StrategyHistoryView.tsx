"use client";

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { Badge } from "@/components/ui/Badge";
import { useResearchRunsByStrategy } from "@/lib/research/use-research-runs-by-strategy";
import { formatDateTime } from "@/lib/utils/format";

export function StrategyHistoryView() {
  const { strategies, isLoading, error } = useResearchRunsByStrategy();

  return (
    <>
      <PageHeader
        title="Strategy History"
        description="Every imported research run, grouped by strategy — version progression, hypotheses, and verdicts over time."
      />

      <Link href="/research" className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-100">
        ← Back to Research
      </Link>

      {isLoading ? (
        <div className="panel px-5 py-6 text-sm text-ink-500">Loading strategy history…</div>
      ) : error ? (
        <div className="panel px-5 py-6 text-sm text-ink-500">{error}</div>
      ) : strategies.length === 0 ? (
        <div className="panel px-5 py-6 text-sm text-ink-500">No research runs imported yet.</div>
      ) : (
        strategies.map((strategy) => (
          <SectionPanel
            key={strategy.strategyName}
            title={strategy.strategyName}
            description={`${strategy.runs.length} research run${strategy.runs.length === 1 ? "" : "s"}`}
          >
            <div
              className="overflow-x-auto scrollbar-thin"
              role="region"
              aria-label={`${strategy.strategyName} research history table`}
              tabIndex={0}
            >
              <table className="w-full min-w-[640px] text-left text-xs">
                <caption className="sr-only">Research run history for {strategy.strategyName}</caption>
                <thead>
                  <tr className="border-b border-base-700/60 text-ink-500">
                    <th scope="col" className="px-4 py-2 font-medium">Run ID</th>
                    <th scope="col" className="px-4 py-2 font-medium">Symbol</th>
                    <th scope="col" className="px-4 py-2 font-medium">Created</th>
                    <th scope="col" className="px-4 py-2 font-medium">Verdict</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-base-700/60">
                  {strategy.runs.map((run) => (
                    <tr key={run.id} className="text-ink-300">
                      <td className="px-4 py-2">
                        <Link
                          href={`/research/${encodeURIComponent(run.runId)}`}
                          className="font-medium text-ink-100 hover:underline"
                        >
                          {run.runId}
                        </Link>
                      </td>
                      <td className="px-4 py-2 text-ink-100">{run.symbol}</td>
                      <td className="px-4 py-2 text-ink-500">{formatDateTime(run.runCreatedAt)}</td>
                      <td className="px-4 py-2">
                        <Badge className="border-base-600 bg-base-800 text-ink-200">{run.verdict}</Badge>
                      </td>
                      <td className="px-4 py-2 text-ink-500">{run.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionPanel>
        ))
      )}
    </>
  );
}
