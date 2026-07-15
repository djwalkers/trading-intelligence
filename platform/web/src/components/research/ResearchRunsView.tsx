"use client";

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { Badge } from "@/components/ui/Badge";
import { useResearchRuns } from "@/lib/research/use-research-runs";
import { formatDateTime } from "@/lib/utils/format";

export function ResearchRunsView() {
  const { runs, isLoading, error } = useResearchRuns();

  return (
    <>
      <PageHeader
        title="Research"
        description="Imported Hermes Lab research runs — hypotheses, results, and verdicts. Evidence ingestion only, no ranking or optimisation."
      />

      <div className="panel flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-xs text-ink-500">
        <span>
          <span className="font-medium text-ink-200">{runs.length}</span> research run
          {runs.length === 1 ? "" : "s"} imported
        </span>
        <Link
          href="/research/strategies"
          className="flex items-center gap-1 text-xs font-medium text-ink-400 transition-colors hover:text-ink-100"
        >
          View strategy history
        </Link>
      </div>

      <SectionPanel
        title="Research runs"
        description={
          runs.length > 0 ? `${runs.length} imported run${runs.length === 1 ? "" : "s"}` : undefined
        }
      >
        {isLoading ? (
          <p className="px-5 py-6 text-sm text-ink-500">Loading research runs…</p>
        ) : error ? (
          <p className="px-5 py-6 text-sm text-ink-500">{error}</p>
        ) : runs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-ink-500">
            No research runs imported yet. Run{" "}
            <code className="rounded bg-base-800 px-1 py-0.5 text-ink-300">
              npm run import-research-run -- &lt;run-id&gt;
            </code>{" "}
            to bring one in from disk.
          </p>
        ) : (
          <div
            className="overflow-x-auto scrollbar-thin"
            role="region"
            aria-label="Research runs table, scroll horizontally for more columns"
            tabIndex={0}
          >
            <table className="w-full min-w-[760px] text-left text-xs">
              <caption className="sr-only">
                Imported research runs with symbol, strategy, verdict, and status
              </caption>
              <thead>
                <tr className="border-b border-base-700/60 text-ink-500">
                  <th scope="col" className="px-4 py-2 font-medium">Run ID</th>
                  <th scope="col" className="px-4 py-2 font-medium">Symbol</th>
                  <th scope="col" className="px-4 py-2 font-medium">Strategy</th>
                  <th scope="col" className="px-4 py-2 font-medium">Created</th>
                  <th scope="col" className="px-4 py-2 font-medium">Verdict</th>
                  <th scope="col" className="px-4 py-2 font-medium">Model</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-base-700/60">
                {runs.map((run) => (
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
                    <td className="px-4 py-2">{run.strategyName}</td>
                    <td className="px-4 py-2 text-ink-500">{formatDateTime(run.runCreatedAt)}</td>
                    <td className="px-4 py-2">
                      <Badge className="border-base-600 bg-base-800 text-ink-200">{run.verdict}</Badge>
                    </td>
                    <td className="px-4 py-2 text-ink-500">{run.model}</td>
                    <td className="px-4 py-2 text-ink-500">{run.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionPanel>
    </>
  );
}
