export interface PaperPosition {
  instrumentSymbol: string;
  instrumentName: string;
  quantity: number;
  averageEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPercent: number;
  openedAt: string;
}

export interface PaperPortfolio {
  startingValue: number;
  currentValue: number;
  cashBalance: number;
  dailyPl: number;
  dailyPlPercent: number;
  totalReturnPercent: number;
  positions: PaperPosition[];
}
