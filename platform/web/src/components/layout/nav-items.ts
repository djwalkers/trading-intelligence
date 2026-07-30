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
  // Legacy-worker UI cleanup. Marks a route as belonging to the legacy paper-trading simulator
  // (see docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md) — hidden from primary navigation, rendered
  // instead under Sidebar's own "Developer / Legacy" heading. Undefined (the default) means
  // primary navigation. Routes are never deleted by this flag — see Sidebar.tsx.
  group?: "legacy";
}

export const navItems: NavItem[] = [
  { href: "/", label: "Dashboard", icon: DashboardIcon },
  { href: "/market-intelligence", label: "Market Intelligence", icon: MarketIntelligenceIcon },
  { href: "/watchlist", label: "Watchlist", icon: WatchlistIcon },
  { href: "/signals", label: "Signals", icon: SignalsIcon },
  { href: "/trade-approval", label: "Trade Approval", icon: TradeApprovalIcon },
  { href: "/performance-analytics", label: "Performance Analytics", icon: PerformanceAnalyticsIcon },
  { href: "/research", label: "Research", icon: ResearchIcon },
  { href: "/strategy-lab", label: "Strategy Laboratory", icon: StrategyLabIcon },
  { href: "/strategies", label: "Strategies", icon: StrategiesIcon },
  { href: "/settings", label: "Settings", icon: SettingsIcon },
  { href: "/system-health", label: "Operations Centre", icon: SystemHealthIcon },
  // Legacy paper-trading simulator — kept fully accessible (routes and data are never deleted),
  // just moved out of primary navigation so it stops reading as part of the live Hermes Agent/
  // eToro platform. See docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md.
  { href: "/portfolio", label: "Paper Portfolio", icon: PortfolioIcon, group: "legacy" },
  { href: "/trade-journal", label: "Trade Journal", icon: JournalIcon, group: "legacy" },
  { href: "/bot-decisions", label: "Bot Decisions", icon: BotIcon, group: "legacy" },
  { href: "/decision-intelligence", label: "AI Decision History", icon: DecisionIntelligenceIcon, group: "legacy" },
];
