import type { PaperPortfolio } from "@/lib/types";

const startingValue = 10_000;
const cashBalance = 3250.0;
const dailyPl = 62.4;

export const paperPortfolio: PaperPortfolio = {
  startingValue,
  cashBalance,
  currentValue: 10_146.2,
  dailyPl,
  dailyPlPercent: (dailyPl / (10_146.2 - dailyPl)) * 100,
  totalReturnPercent: ((10_146.2 - startingValue) / startingValue) * 100,
  positions: [
    {
      instrumentSymbol: "AAPL",
      instrumentName: "Apple Inc.",
      quantity: 10,
      averageEntryPrice: 160.0,
      currentPrice: 168.5,
      marketValue: 1685.0,
      unrealizedPl: 85.0,
      unrealizedPlPercent: 5.31,
      openedAt: "2026-06-18T09:32:00Z",
    },
    {
      instrumentSymbol: "MSFT",
      instrumentName: "Microsoft Corporation",
      quantity: 4,
      averageEntryPrice: 350.0,
      currentPrice: 348.2,
      marketValue: 1392.8,
      unrealizedPl: -7.2,
      unrealizedPlPercent: -0.51,
      openedAt: "2026-06-24T14:05:00Z",
    },
    {
      instrumentSymbol: "TSLA",
      instrumentName: "Tesla, Inc.",
      quantity: 6,
      averageEntryPrice: 195.0,
      currentPrice: 198.55,
      marketValue: 1191.3,
      unrealizedPl: 21.3,
      unrealizedPlPercent: 1.82,
      openedAt: "2026-07-01T10:12:00Z",
    },
    {
      instrumentSymbol: "NVDA",
      instrumentName: "NVIDIA Corporation",
      quantity: 12,
      averageEntryPrice: 105.0,
      currentPrice: 107.9,
      marketValue: 1294.8,
      unrealizedPl: 34.8,
      unrealizedPlPercent: 2.76,
      openedAt: "2026-07-03T11:47:00Z",
    },
    {
      instrumentSymbol: "SPY",
      instrumentName: "S&P 500 ETF Trust",
      quantity: 3,
      averageEntryPrice: 440.0,
      currentPrice: 444.1,
      marketValue: 1332.3,
      unrealizedPl: 12.3,
      unrealizedPlPercent: 0.93,
      openedAt: "2026-06-10T09:31:00Z",
    },
  ],
};
