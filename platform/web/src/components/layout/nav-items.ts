import type { ComponentType, SVGProps } from "react";
import {
  BotIcon,
  DashboardIcon,
  JournalIcon,
  MarketIntelligenceIcon,
  PortfolioIcon,
  SignalsIcon,
  StrategiesIcon,
  SystemHealthIcon,
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
  { href: "/strategies", label: "Strategies", icon: StrategiesIcon },
  { href: "/system-health", label: "System Health", icon: SystemHealthIcon },
];
