import type { HTMLAttributes } from "react";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  className?: string;
}

// Phase 2A.1 — extends native span attributes (mirrors Button.tsx's own ButtonHTMLAttributes
// convention) so callers can attach data-testid/aria-* attributes — previously silently dropped,
// since this component only ever rendered {children} with no attribute pass-through at all.
export function Badge({ children, className = "", ...props }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium leading-none ${className}`}
      {...props}
    >
      {children}
    </span>
  );
}
