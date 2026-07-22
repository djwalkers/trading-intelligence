import { PageHeader } from "@/components/ui/PageHeader";
import { MarketDiagnosticsView } from "@/components/market-intelligence/diagnostics/MarketDiagnosticsView";
import { fetchMarketDiagnostics } from "./actions";

export const metadata = {
  title: "Market Diagnostics | Trading Intelligence Platform",
};

// Force-dynamic: this page's whole purpose is to show fresh market data on every visit, never a
// statically cached render — mirrors the API route's own `dynamic = "force-dynamic"`.
export const dynamic = "force-dynamic";

// Phase 2A.1 — Internal Market Diagnostics UI. Server Component: fetches the very first render's
// data server-side (via the same Server Action the client-side refresh button also calls — see
// actions.ts) so the page shows real data immediately, with no client-side loading flash and no
// separate initial-fetch code path to keep in sync with the refresh path.
export default async function MarketDiagnosticsPage() {
  const initial = await fetchMarketDiagnostics();

  return (
    <>
      <PageHeader
        title="Market Diagnostics"
        description="Internal, read-only view of live market-data quality and indicator calculations — for operational verification and debugging only. Never places an order."
      />
      <MarketDiagnosticsView initial={initial} />
    </>
  );
}
