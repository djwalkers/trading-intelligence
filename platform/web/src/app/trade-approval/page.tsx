import { PageHeader } from "@/components/ui/PageHeader";
import { TradeApprovalView } from "@/components/trade-approval/TradeApprovalView";

export const metadata = {
  title: "Trade Approval | Trading Intelligence Platform",
};

// Force-dynamic: this page's whole purpose is showing the current, live queue of trade candidates
// — never a statically cached render. Mirrors the diagnostics/decision-intelligence pages' own
// convention.
export const dynamic = "force-dynamic";

// Phase 3.5 — Trade Review & Approval. Every BUY/SELL decision the trading runtime makes now stops
// here, as a PENDING TradeCandidate, before it can ever reach the broker — see
// docs/trade-candidate-lifecycle-phase-3-5.md for the full architecture. This page is the only
// place a human turns a candidate into APPROVED or REJECTED; automatic execution stays off
// unconditionally regardless of what happens on this page.
export default function TradeApprovalPage() {
  return (
    <>
      <PageHeader
        title="Trade Approval"
        description="Every BUY/SELL decision the trading runtime makes is queued here for review before it can reach the broker. Nothing executes automatically."
      />
      <TradeApprovalView />
    </>
  );
}
