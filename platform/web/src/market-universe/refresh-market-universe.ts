import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ExclusionReason, RefreshRunStats } from "@/lib/market-universe/types";
import { downloadListingSource } from "@/lib/market-universe/download-listing-files";
import {
  combineListingSnapshot,
  parseNasdaqListedFile,
  parseOtherListedFile,
} from "@/lib/market-universe/parse-nasdaq-listing-files";
import {
  getAllUniverseRows,
  recordPriceCheckResults,
  selectPriceCheckBatch,
  upsertUniverseSnapshot,
} from "@/lib/market-universe/universe-store";
import { checkPrices, PRICE_CHECK_BATCH_SIZE } from "@/lib/market-universe/price-eligibility";
import { completeRefreshRun, failRefreshRun, startRefreshRun } from "@/lib/market-universe/refresh-log-store";
import { log } from "@/lib/market-universe/logger";

const DATA_SOURCE = "NasdaqTrader";

const EMPTY_EXCLUSION_BREAKDOWN: Record<ExclusionReason, number> = {
  test_issue: 0,
  unsupported_instrument_type: 0,
  price_below_minimum: 0,
  delisted: 0,
};

// Runs one full refresh: download the two official NASDAQ Trader files, parse and classify them,
// diff against the currently-persisted universe and apply only the writes that changed anything,
// run one incremental price-check batch, recompute eligibility for the symbols just checked, and
// record the run's statistics. Never touches market_universe_symbols if the download itself fails
// — a network blip degrades to "yesterday's universe, one refresh late," never to "no universe" or
// a corrupt one. See docs/product/PHASE-2A-MARKET-UNIVERSE.md, "Refresh strategy".
export async function refreshMarketUniverse(client: SupabaseClient): Promise<RefreshRunStats> {
  const startedAt = Date.now();
  const runId = await startRefreshRun(client, DATA_SOURCE);
  log("refresh_started", { runId, dataSource: DATA_SOURCE });

  try {
    const { nasdaqListed, otherListed, fetchedAt } = await downloadListingSource();
    const nasdaqRows = parseNasdaqListedFile(nasdaqListed);
    const otherRows = parseOtherListedFile(otherListed);
    const { snapshot, collisions } = combineListingSnapshot(nasdaqRows, otherRows);
    log("listing_source_downloaded", {
      nasdaqRowCount: nasdaqRows.length,
      otherRowCount: otherRows.length,
      combinedSymbolCount: snapshot.size,
      collisionCount: collisions.length,
    });
    for (const collision of collisions) {
      log("listing_source_downloaded", {
        collision: collision.symbol,
        keptExchange: collision.kept.exchange,
        droppedExchange: collision.dropped.exchange,
      });
    }

    const now = new Date().toISOString();
    const diff = await upsertUniverseSnapshot(client, snapshot, now, DATA_SOURCE, fetchedAt);
    log("universe_diffed", {
      newListings: diff.newRows.length,
      delistings: diff.delistedSymbols.length,
      metadataChanges: diff.changedRows.length,
      unchanged: diff.unchangedSymbols.length,
    });

    const batch = await selectPriceCheckBatch(client, PRICE_CHECK_BATCH_SIZE);
    log("price_check_batch_selected", { batchSize: batch.length });

    let priceResults: Awaited<ReturnType<typeof checkPrices>> = [];
    if (batch.length > 0) {
      priceResults = await checkPrices(batch.map((row) => row.symbol));
      await recordPriceCheckResults(client, batch, priceResults);
    }
    const priceCheckFailures = priceResults.filter((r) => r.failed).length;
    log("price_check_completed", {
      performed: priceResults.length,
      failed: priceCheckFailures,
    });

    const allRows = await getAllUniverseRows(client);
    const exclusionReasonBreakdown = { ...EMPTY_EXCLUSION_BREAKDOWN };
    let eligibleCount = 0;
    let excludedCount = 0;
    let awaitingPriceCheckCount = 0;
    for (const row of allRows) {
      if (row.isEligible) {
        eligibleCount++;
      } else if (row.exclusionReason) {
        excludedCount++;
        exclusionReasonBreakdown[row.exclusionReason]++;
      } else {
        // Not eligible, but no settled exclusion reason either — awaiting its first price check.
        awaitingPriceCheckCount++;
      }
    }

    const stats: RefreshRunStats = {
      totalDownloaded: snapshot.size,
      newListingsCount: diff.newRows.length,
      delistingsCount: diff.delistedSymbols.length,
      metadataChangesCount: diff.changedRows.length,
      priceChecksPerformed: priceResults.length,
      priceCheckFailures,
      eligibleCount,
      excludedCount,
      exclusionReasonBreakdown,
      awaitingPriceCheckCount,
      durationMs: Date.now() - startedAt,
    };

    await completeRefreshRun(client, runId, stats);
    log("refresh_completed", stats as unknown as Record<string, unknown>);
    return stats;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown refresh error";
    await failRefreshRun(client, runId, message);
    log("refresh_failed", { error: message });
    throw error;
  }
}
