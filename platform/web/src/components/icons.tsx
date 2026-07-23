import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

export function WatchlistIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.75" />
    </svg>
  );
}

export function SignalsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h4l2.2-7L13 19l2.4-7H21" />
    </svg>
  );
}

export function PortfolioIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="7.5" width="18" height="12" rx="2" />
      <path d="M8 7.5V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v1.5" />
      <path d="M3 12.5h18" />
    </svg>
  );
}

export function StrategiesIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
      <path d="m3.5 12 8.5 4.5 8.5-4.5" />
      <path d="m3.5 16.5 8.5 4.5 8.5-4.5" />
    </svg>
  );
}

export function SystemHealthIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12h3.5l2-5 3 10 2-7 1.5 2H21" />
    </svg>
  );
}

export function MarketIntelligenceIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m14.5 9.5-2 5-5 2 2-5 5-2Z" />
    </svg>
  );
}

export function JournalIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="4.5" y="3.5" width="15" height="17" rx="1.5" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

export function BotIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="5" y="8.5" width="14" height="10" rx="2.5" />
      <path d="M12 8.5V5" />
      <circle cx="12" cy="3.5" r="1.25" />
      <circle cx="9" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="13.5" r="1.1" fill="currentColor" stroke="none" />
      <path d="M2.5 12.5h2.5M19 12.5h2.5" />
    </svg>
  );
}

// Archive-box shape — long-term record history (Mission 7's Decision Intelligence), deliberately
// not brain/AI iconography since this mission is explicitly not about AI.
export function DecisionIntelligenceIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3.5" y="4.5" width="17" height="4.5" rx="1.25" />
      <path d="M4.5 9v8.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

// Flask/beaker shape — imported Hermes Lab research output (hypotheses, results, evidence),
// deliberately distinct from every other icon here since nothing else in this app represents
// external research specifically.
export function ResearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M9.5 3.5h5" />
      <path d="M10.3 3.5v5.3l-4.4 7.4a2 2 0 0 0 1.7 3h8.8a2 2 0 0 0 1.7-3l-4.4-7.4V3.5" />
      <path d="M7.7 14.2h8.6" />
    </svg>
  );
}

// Checkmark-in-shield shape — human review/approval gate (Phase 3.5's Trade Approval page),
// deliberately distinct from BotIcon (the automatic runtime) since this page is specifically where
// a human, not the bot, makes the final call.
export function TradeApprovalIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3.5 19 6.5V11c0 4.5-3 7.5-7 9.5-4-2-7-5-7-9.5V6.5L12 3.5Z" />
      <path d="m9 12 2 2 4-4.5" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function DotIcon({ className = "", ...props }: IconProps) {
  return (
    <svg viewBox="0 0 8 8" fill="currentColor" className={`h-2 w-2 ${className}`} {...props}>
      <circle cx="4" cy="4" r="4" />
    </svg>
  );
}
