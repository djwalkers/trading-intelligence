"use client";

import { Button } from "@/components/ui/Button";
import type { AnalysisDecision, AnalysisRetentionWindow } from "@/lib/hermes-execution/analysis/types";

export interface AnalysisFilterState {
  search: string;
  retention: AnalysisRetentionWindow;
  instrument: string;
  decision: AnalysisDecision | "";
  strategyId: string;
}

interface AnalysisFilterPanelProps {
  filter: AnalysisFilterState;
  onChange: (next: AnalysisFilterState) => void;
  availableInstruments: string[];
  availableStrategies: string[];
  onExportCsv: () => void;
  exportDisabled: boolean;
}

const RETENTION_OPTIONS: { value: AnalysisRetentionWindow; label: string }[] = [
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "365d", label: "365 days" },
  { value: "all", label: "All time" },
];

const DECISION_OPTIONS: AnalysisDecision[] = ["BUY", "SELL", "HOLD", "ERROR"];

const SELECT_CLASS =
  "rounded-lg border border-base-700 bg-base-800 px-3 py-2 text-sm text-ink-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50";
const INPUT_CLASS = `${SELECT_CLASS} placeholder:text-ink-500`;

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Every control here only ever
// changes what's DISPLAYED (a client-side filter/query over already-persisted, read-only data) —
// nothing on this page can write to market_analysis_runs, place an order, or change configuration.
export function AnalysisFilterPanel({
  filter,
  onChange,
  availableInstruments,
  availableStrategies,
  onExportCsv,
  exportDisabled,
}: AnalysisFilterPanelProps) {
  return (
    <div className="panel flex flex-wrap items-end gap-3 p-5">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-500">Search</span>
        <input
          type="text"
          className={INPUT_CLASS}
          placeholder="Instrument, strategy, reason…"
          value={filter.search}
          onChange={(e) => onChange({ ...filter, search: e.target.value })}
          data-testid="filter-search"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-500">Date range</span>
        <select
          className={SELECT_CLASS}
          value={filter.retention}
          onChange={(e) => onChange({ ...filter, retention: e.target.value as AnalysisRetentionWindow })}
          data-testid="filter-retention"
        >
          {RETENTION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-500">Instrument</span>
        <select
          className={SELECT_CLASS}
          value={filter.instrument}
          onChange={(e) => onChange({ ...filter, instrument: e.target.value })}
          data-testid="filter-instrument"
        >
          <option value="">All instruments</option>
          {availableInstruments.map((instrument) => (
            <option key={instrument} value={instrument}>
              {instrument}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-500">Decision</span>
        <select
          className={SELECT_CLASS}
          value={filter.decision}
          onChange={(e) => onChange({ ...filter, decision: e.target.value as AnalysisDecision | "" })}
          data-testid="filter-decision"
        >
          <option value="">All decisions</option>
          {DECISION_OPTIONS.map((decision) => (
            <option key={decision} value={decision}>
              {decision}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-ink-500">Strategy</span>
        <select
          className={SELECT_CLASS}
          value={filter.strategyId}
          onChange={(e) => onChange({ ...filter, strategyId: e.target.value })}
          data-testid="filter-strategy"
        >
          <option value="">All strategies</option>
          {availableStrategies.map((strategyId) => (
            <option key={strategyId} value={strategyId}>
              {strategyId}
            </option>
          ))}
        </select>
      </label>

      <Button variant="secondary" onClick={onExportCsv} disabled={exportDisabled} data-testid="export-csv-button">
        Export CSV
      </Button>
    </div>
  );
}
