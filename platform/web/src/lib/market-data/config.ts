import { getClientConfig } from "@/lib/config/client-config";

// Purely informational presence check — neither variable is required to run the app. See
// get-market-data-provider.ts for the actual selection logic.
export function isExternalMarketDataConfigured(): boolean {
  return getClientConfig().isExternalMarketDataConfigured;
}
