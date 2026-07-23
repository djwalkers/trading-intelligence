import type { ComponentType, SVGProps } from "react";
import {
  BotIcon,
  DashboardIcon,
  DecisionIntelligenceIcon,
  JournalIcon,
  MarketIntelligenceIcon,
  PerformanceAnalyticsIcon,
  PortfolioIcon,
  ResearchIcon,
  SettingsIcon,
  SignalsIcon,
  StrategiesIcon,
  StrategyLabIcon,
  SystemHealthIcon,
  TradeApprovalIcon,
  WatchlistIcon,
} from "@/components/icons";

export interface NavItem {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
}

export const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: DashboardIcon },
  { href: "/market-intelligence", label: "Market Intelligence", icon: MarketIntelligenceIcon },
  { href: "/watchlist", label: "Watchlist", icon: WatchlistIcon },
  { href: "/signals", label: "Signals", icon: SignalsIcon },
  { href: "/portfolio", label: "Paper Portfolio", icon: PortfolioIcon },
  { href: "/trade-journal", label: "Trade Journal", icon: JournalIcon },
  { href: "/bot-decisions", label: "Bot Decisions", icon: BotIcon },
  { href: "/trade-approval", label: "Trade Approval", icon: TradeApprovalIcon },
  { href: "/performance-analytics", label: "Performance Analytics", icon: PerformanceAnalyticsIcon },
  { href: "/decision-intelligence", label: "AI Decision History", icon: DecisionIntelligenceIcon },
  { href: "/research", label: "Research", icon: ResearchIcon },
  { href: "/strategy-lab", label: "Strategy Laboratory", icon: StrategyLabIcon },
  { href: "/strategies", label: "Strategies", icon: StrategiesIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/system-health", label: "Operations Centre", icon: SystemHealthIcon },
];
