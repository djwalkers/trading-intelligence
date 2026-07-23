import { PageHeader } from "@/components/ui/PageHeader";
import { PerformanceAnalyticsView } from "@/components/performance-analytics/PerformanceAnalyticsView";

export const metadata = {
  title: "Performance Analytics | Trading Intelligence Platform",
};

export const dynamic = "force-dynamic";

// Phase 4 — Trade Performance Engine. Objectively measures the quality of decisions this platform
// has already made and executed — it never improves, changes, or influences a decision, a strategy,
// risk, the broker, the scheduler, or the trade approval workflow. See
// docs/trade-performance-engine-phase-4.md for the full architecture.
export default function PerformanceAnalyticsPage() {
  return (
    <>
      <PageHeader
        title="Performance Analytics"
        description="Objective, after-the-fact measurement of every closed trade — equity curve, win/loss, strategy comparison, and the full analysis-to-performance chain. Read-only."
      />
      <PerformanceAnalyticsView />
    </>
  );
}
