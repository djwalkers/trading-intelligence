import { PageHeader } from "@/components/ui/PageHeader";
import { StrategyLabView } from "@/components/strategy-lab/StrategyLabView";

export const metadata = {
  title: "Strategy Laboratory | Trading Intelligence Platform",
};

export const dynamic = "force-dynamic";

// Phase 5 — Strategy Research Laboratory. Run a strategy against historical analysis data without
// affecting live trading — see docs/strategy-research-laboratory-phase-5.md for the full
// architecture. Research mode is read-only: it never places an order, never modifies production
// history, and never writes to Supabase.
export default function StrategyLabPage() {
  return (
    <>
      <PageHeader
        title="Strategy Laboratory"
        description="Run a strategy against historical analysis data, compare it against another, and see exactly where and why they diverge. Read-only — never places a trade."
      />
      <StrategyLabView />
    </>
  );
}
