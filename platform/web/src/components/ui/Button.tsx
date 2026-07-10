"use client";

import { forwardRef, type ButtonHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "danger";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary: "border border-accent-teal/30 bg-accent-teal/10 text-accent-teal hover:bg-accent-teal/20",
  secondary: "text-ink-400 hover:text-ink-100",
  danger: "border border-accent-red/30 bg-accent-red/10 text-accent-red hover:bg-accent-red/20",
};

// Build 1.12.2 — shared button styling and interaction states (default/hover/focus/disabled),
// extracted from three near-identical inline className strings duplicated across the trading
// modals. A styling/behaviour consolidation only — doesn't change what any button does.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", disabled, className, type = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASSES[variant]} ${className ?? ""}`}
      {...props}
    />
  );
});
