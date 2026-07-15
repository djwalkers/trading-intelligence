"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fromSummaryDbRow, RESEARCH_RUN_SUMMARY_COLUMNS, type ResearchRunSummaryDbRow } from "./research-run-mapper";
import type { ResearchRunSummary } from "./types";

interface UseResearchRunsResult {
  runs: ResearchRunSummary[];
  isLoading: boolean;
  error: string | null;
}

// Deliberately no Context/Provider, unlike DecisionHistoryProvider — research runs have no
// local-storage-only fallback mode (they only ever exist via the service-role import CLI), so a
// shared-state layer built for "Supabase might not be configured at all" would be unused
// complexity here, not a redesign of anything existing. A plain fetch-on-mount hook is sufficient.
export function useResearchRuns(): UseResearchRunsResult {
  const [runs, setRuns] = useState<ResearchRunSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const client = getSupabaseClient();
      if (!client) {
        if (!cancelled) {
          setError("Research runs require Supabase to be configured.");
          setIsLoading(false);
        }
        return;
      }

      const { data, error: queryError } = await client
        .from("research_runs")
        .select(RESEARCH_RUN_SUMMARY_COLUMNS)
        .order("run_created_at", { ascending: false });

      if (cancelled) return;
      if (queryError) {
        setError(queryError.message);
      } else {
        setRuns(((data ?? []) as ResearchRunSummaryDbRow[]).map(fromSummaryDbRow));
      }
      setIsLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return { runs, isLoading, error };
}
