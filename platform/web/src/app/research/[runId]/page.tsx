import { ResearchRunDetailView } from "@/components/research/ResearchRunDetailView";

export const metadata = {
  title: "Research Run | Trading Intelligence Platform",
};

// Phase 2 — the first dynamic route segment in this app. Standard Next.js App Router convention
// (params is a Promise as of Next.js 15+); the view component itself does all data fetching
// client-side via useResearchRun(runId), matching every other page in this app.
export default async function ResearchRunDetailPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <ResearchRunDetailView runId={runId} />;
}
