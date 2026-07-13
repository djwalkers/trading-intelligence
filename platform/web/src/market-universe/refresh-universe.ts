import { getServiceRoleClient } from "@/lib/supabase/service-role-client";
import { refreshMarketUniverse } from "./refresh-market-universe";
import { log } from "@/lib/market-universe/logger";

// A single, complete Market Universe refresh — download, classify, diff/upsert, one incremental
// price-check batch, record statistics. Only ever run directly (`npm run refresh-universe`), never
// imported by the Next.js app or the worker. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
async function main(): Promise<void> {
  const client = getServiceRoleClient();
  if (!client) {
    log("refresh_failed", {
      error:
        "SUPABASE_SERVICE_ROLE_KEY and/or NEXT_PUBLIC_SUPABASE_URL are not set — the refresh has nothing to connect to.",
    });
    process.exitCode = 1;
    return;
  }

  try {
    const stats = await refreshMarketUniverse(client);
    console.log("\nMarket Universe refresh complete:");
    console.log(`  Total downloaded:  ${stats.totalDownloaded}`);
    console.log(`  Eligible:          ${stats.eligibleCount}`);
    console.log(`  Excluded:          ${stats.excludedCount}`);
    console.log(`  Exclusion reasons: ${JSON.stringify(stats.exclusionReasonBreakdown)}`);
    console.log(`  Awaiting price check (not excluded, not yet knowable): ${stats.awaitingPriceCheckCount}`);
    console.log(`  New listings:      ${stats.newListingsCount}`);
    console.log(`  Delistings:        ${stats.delistingsCount}`);
    console.log(`  Metadata changes:  ${stats.metadataChangesCount}`);
    console.log(`  Price checks:      ${stats.priceChecksPerformed} (${stats.priceCheckFailures} failed)`);
    console.log(`  Data source:       NasdaqTrader`);
    console.log(`  Duration:          ${stats.durationMs}ms`);
  } catch (error) {
    console.error("Market Universe refresh failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main();
