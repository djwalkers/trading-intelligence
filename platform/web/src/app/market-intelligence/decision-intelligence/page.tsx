import { PageHeader } from "@/components/ui/PageHeader";
import { DecisionIntelligenceView } from "@/components/market-intelligence/decision-intelligence/DecisionIntelligenceView";

export const metadata = {
  title: "Decision Intelligence | Trading Intelligence Platform",
};

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. Route deliberately NOT
// /decision-intelligence — that path already exists for an unrelated, pre-existing feature (the
// mock/strategy-engine bot's own "AI Decision History" page, src/app/decision-intelligence/). This
// page is Hermes-specific, nested under /market-intelligence like the diagnostics page, to avoid
// any collision or confusion between the two.
export default function HermesDecisionIntelligencePage() {
  return (
    <>
      <PageHeader
        title="Decision Intelligence"
        description="Full historical record of every Hermes trading-runtime analysis cycle — read-only, for review and future performance analysis."
      />
      <DecisionIntelligenceView />
    </>
  );
}
