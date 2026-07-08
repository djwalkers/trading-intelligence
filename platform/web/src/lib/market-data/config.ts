// Purely informational presence check — neither variable is required to run the app. See
// get-market-data-provider.ts for the actual selection logic.
export function isExternalMarketDataConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER && process.env.NEXT_PUBLIC_MARKET_DATA_API_KEY,
  );
}
