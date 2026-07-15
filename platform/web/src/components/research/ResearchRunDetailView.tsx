"use client";

import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { Badge } from "@/components/ui/Badge";
import { MarkdownContent } from "./MarkdownContent";
import { useResearchRun } from "@/lib/research/use-research-run";
import { formatDateTime } from "@/lib/utils/format";

interface ResearchRunDetailViewProps {
  runId: string;
}

function formatMetricValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
}

function formatDiffValue(value: number | undefined): string {
  if (value === undefined) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${Number.isInteger(value) ? value : value.toFixed(4)}`;
}

function ResultsTable({
  resultsV1,
  resultsV2,
  resultsDiff,
}: {
  resultsV1: Record<string, unknown>;
  resultsV2: Record<string, unknown>;
  resultsDiff: Record<string, number>;
}) {
  const metricKeys = Array.from(new Set([...Object.keys(resultsV1), ...Object.keys(resultsV2)])).sort();

  if (metricKeys.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No metrics recorded for this run.</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin" role="region" aria-label="Results comparison table" tabIndex={0}>
      <table className="w-full min-w-[520px] text-left text-xs">
        <caption className="sr-only">Version 1 vs version 2 metrics and their difference</caption>
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">Metric</th>
            <th scope="col" className="px-4 py-2 font-medium">Version 1</th>
            <th scope="col" className="px-4 py-2 font-medium">Version 2</th>
            <th scope="col" className="px-4 py-2 font-medium">Difference</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {metricKeys.map((key) => (
            <tr key={key} className="text-ink-300">
              <td className="px-4 py-2 text-ink-100">{key}</td>
              <td className="px-4 py-2">{formatMetricValue(resultsV1[key])}</td>
              <td className="px-4 py-2">{formatMetricValue(resultsV2[key])}</td>
              <td className="px-4 py-2">{formatDiffValue(resultsDiff[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResearchRunDetailView({ runId }: ResearchRunDetailViewProps) {
  const { run, isLoading, error } = useResearchRun(runId);

  if (isLoading) {
    return (
      <>
        <PageHeader title="Research run" description="Loading…" />
        <div className="panel px-5 py-6 text-sm text-ink-500">Loading research run…</div>
      </>
    );
  }

  if (error || !run) {
    return (
      <>
        <PageHeader title="Research run" description={runId} />
        <div className="panel px-5 py-6 text-sm text-ink-500">
          {error ?? "This research run could not be found."}
        </div>
        <Link href="/research" className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-100">
          ← Back to Research
        </Link>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={run.runId}
        description={`${run.symbol} · ${run.strategyName} · Imported ${formatDateTime(run.importedAt)}`}
      />

      <Link href="/research" className="text-xs font-medium text-ink-400 transition-colors hover:text-ink-100">
        ← Back to Research
      </Link>

      <SectionPanel title="General">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 px-5 py-4 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-ink-500">Run ID</dt>
            <dd className="mt-0.5 text-ink-100">{run.runId}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Model</dt>
            <dd className="mt-0.5 text-ink-100">{run.model}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Data source</dt>
            <dd className="mt-0.5 text-ink-100">{run.dataSource}</dd>
          </div>
          <div>
            <dt className="text-ink-500">Date range</dt>
            <dd className="mt-0.5 text-ink-100">
              {run.dateRangeStart ?? "—"} – {run.dateRangeEnd ?? "—"}
            </dd>
          </div>
        </dl>
      </SectionPanel>

      <SectionPanel title="Hypothesis">
        <div className="flex flex-col gap-4 px-5 py-4 text-xs">
          <div>
            <p className="text-ink-500">Hypothesis</p>
            <p className="mt-1 text-ink-200">{run.hypothesis}</p>
          </div>
          <div>
            <p className="text-ink-500">Falsification criterion</p>
            <p className="mt-1 text-ink-200">{run.falsificationCriterion}</p>
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title="Results" description="Version 1 vs version 2, with the computed difference">
        <ResultsTable resultsV1={run.resultsV1} resultsV2={run.resultsV2} resultsDiff={run.resultsDiff} />
      </SectionPanel>

      <SectionPanel title="Conclusion">
        <div className="flex flex-col gap-4 px-5 py-4 text-xs">
          <div>
            <p className="text-ink-500">Verdict</p>
            <Badge className="mt-1 border-base-600 bg-base-800 text-ink-200">{run.verdict}</Badge>
          </div>
          <div>
            <p className="text-ink-500">Verdict reason</p>
            <p className="mt-1 text-ink-200">{run.verdictReason}</p>
          </div>
        </div>
      </SectionPanel>

      <SectionPanel title="Evidence" description="hypothesis.md and comparison.md, rendered as authored">
        <div className="flex flex-col gap-6 px-5 py-4">
          <div>
            <h3 className="mb-2 text-xs font-medium text-ink-500">hypothesis.md</h3>
            <MarkdownContent>{run.hypothesisMarkdown}</MarkdownContent>
          </div>
          <div>
            <h3 className="mb-2 text-xs font-medium text-ink-500">comparison.md</h3>
            <MarkdownContent>{run.comparisonMarkdown}</MarkdownContent>
          </div>
        </div>
      </SectionPanel>
    </>
  );
}
