"use client";

import { useEffect, useState } from "react";
import { getSupabaseClient } from "@/lib/supabase/client";
import { fromDbRow, type ResearchRunDbRow } from "./research-run-mapper";
import type { ResearchRun } from "./types";

interface UseResearchRunResult {
  run: ResearchRun | null;
  isLoading: boolean;
  error: string | null;
}

// One full row, by Hermes Lab's own run_id (the URL param), for the detail page only — the list and
// Strategy History pages use useResearchRuns()'s lighter summary query instead.
export function useResearchRun(runId: string): UseResearchRunResult {
  const [run, setRun] = useState<ResearchRun | null>(null);
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
        .select("*")
        .eq("run_id", runId)
        .maybeSingle();

      if (cancelled) return;
      if (queryError) {
        setError(queryError.message);
      } else {
        setRun(data ? fromDbRow(data as ResearchRunDbRow) : null);
      }
      setIsLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return { run, isLoading, error };
}
