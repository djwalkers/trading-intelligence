"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { MarketOverviewPanel } from "@/components/market-intelligence/MarketOverviewPanel";
import { OpportunityList } from "@/components/market-intelligence/OpportunityList";
import { DecisionBreakdownPanel } from "@/components/market-intelligence/DecisionBreakdownPanel";
import { IntelligenceScoreDisplay } from "@/components/market-intelligence/IntelligenceScoreDisplay";
import { IntelligenceScoreBreakdown } from "@/components/market-intelligence/IntelligenceScoreBreakdown";
import { ScoreExplanation } from "@/components/market-intelligence/ScoreExplanation";
import { RecommendationPanel } from "@/components/market-intelligence/RecommendationPanel";
import { EvidenceBulletList } from "@/components/market-intelligence/EvidenceBulletList";
import { ComparisonTable } from "@/components/market-intelligence/ComparisonTable";
import { PaperTradeModal } from "@/components/trading/PaperTradeModal";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { buildPaperTradeFromOpportunity, isTradeableRecommendation } from "@/lib/utils/paper-trade";
import { calculateOverallIntelligenceScore } from "@/lib/utils/intelligence-score";
import type { MarketOverview, MarketStatus, Opportunity, PaperTrade } from "@/lib/types";

interface MarketIntelligenceViewProps {
  overview: MarketOverview;
  opportunities: Opportunity[];
  marketStatus: MarketStatus;
}

const MAX_COMPARE = 3;

export function MarketIntelligenceView({
  overview,
  opportunities,
  marketStatus,
}: MarketIntelligenceViewProps) {
  const rankedOpportunities = [...opportunities].sort(
    (a, b) => b.confidencePercent - a.confidencePercent,
  );

  const [selectedId, setSelectedId] = useState<string | null>(rankedOpportunities[0]?.id ?? null);
  const selected = rankedOpportunities.find((opportunity) => opportunity.id === selectedId);

  const [compareIds, setCompareIds] = useState<string[]>([]);
  const compareOpportunities = rankedOpportunities.filter((opportunity) =>
    compareIds.includes(opportunity.id),
  );

  function handleToggleCompare(id: string) {
    setCompareIds((previous) => {
      if (previous.includes(id)) {
        return previous.filter((existingId) => existingId !== id);
      }
      if (previous.length >= MAX_COMPARE) {
        return previous;
      }
      return [...previous, id];
    });
  }

  const { addTrade, hasTradeForOpportunity } = usePaperTrades();
  const [pendingTrade, setPendingTrade] = useState<PaperTrade | null>(null);

  function handlePaperTrade() {
    if (!selected) return;
    setPendingTrade(buildPaperTradeFromOpportunity(selected));
  }

  function handleConfirm() {
    if (pendingTrade) {
      addTrade(pendingTrade);
    }
    setPendingTrade(null);
  }

  return (
    <>
      <PageHeader
        title="Market Intelligence"
        description="Understand first. Decide second. Trade last."
      />

      <SectionPanel
        title="Market overview"
        description="A snapshot of current conditions across tracked instruments"
      >
        <MarketOverviewPanel overview={overview} marketStatus={marketStatus} />
      </SectionPanel>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <SectionPanel
            title="Opportunities"
            description="Ranked by confidence · tick up to 3 to compare"
          >
            <OpportunityList
              opportunities={rankedOpportunities}
              selectedId={selected?.id ?? null}
              onSelect={setSelectedId}
              compareIds={compareIds}
              onToggleCompare={handleToggleCompare}
              maxCompare={MAX_COMPARE}
            />
          </SectionPanel>
        </div>

        <div className="flex flex-col gap-6 lg:col-span-3">
          {selected ? (
            <>
              <DecisionBreakdownPanel opportunity={selected} />

              <SectionPanel
                title="Intelligence score"
                description="A 0-100 composite across seven factors"
              >
                <div className="flex flex-col gap-4 px-5 py-4">
                  <IntelligenceScoreDisplay
                    overall={calculateOverallIntelligenceScore(selected.intelligenceFactors)}
                  />
                  <IntelligenceScoreBreakdown factors={selected.intelligenceFactors} />
                </div>
              </SectionPanel>

              <ScoreExplanation
                factors={selected.intelligenceFactors}
                overall={calculateOverallIntelligenceScore(selected.intelligenceFactors)}
              />

              <RecommendationPanel
                opportunity={selected}
                tradeable={isTradeableRecommendation(selected.recommendation)}
                alreadyTraded={hasTradeForOpportunity(selected.id)}
                onPaperTrade={handlePaperTrade}
              />
              <EvidenceBulletList title="Why this recommendation?" items={selected.whyEvidence} />
              <EvidenceBulletList
                title="What could change?"
                description="Signals that would invalidate this view"
                items={selected.invalidationFactors}
                tone="risk"
              />
            </>
          ) : (
            <SectionPanel title="Decision breakdown">
              <p className="px-5 py-6 text-sm text-ink-500">
                Select an opportunity to see its full breakdown.
              </p>
            </SectionPanel>
          )}
        </div>
      </div>

      <SectionPanel
        title="Compare opportunities"
        description={`${compareOpportunities.length} of ${MAX_COMPARE} selected`}
      >
        <ComparisonTable opportunities={compareOpportunities} />
      </SectionPanel>

      <InfoNote>
        Market Intelligence is generated from mock analytical rules for prototyping purposes. It is
        not financial advice and should not be used to make real trading decisions. Understand the
        evidence first, form your own view second, and only ever trade with capital you can afford
        to lose.
      </InfoNote>

      {pendingTrade ? (
        <PaperTradeModal
          instrumentSymbol={pendingTrade.instrumentSymbol}
          instrumentName={pendingTrade.instrumentName}
          side={pendingTrade.side}
          quantity={pendingTrade.quantity}
          entryPrice={pendingTrade.entryPrice}
          confidencePercent={pendingTrade.signalConfidence}
          strategyName={pendingTrade.strategyName}
          sourceLabel="Market Intelligence"
          onConfirm={handleConfirm}
          onCancel={() => setPendingTrade(null)}
        />
      ) : null}
    </>
  );
}
