"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/components/layout/nav-items";
import { marketStatus } from "@/lib/mock";
import { Badge } from "@/components/ui/Badge";
import { DotIcon } from "@/components/icons";

// Legacy-worker UI cleanup. Mobile has no sidebar, so there is no separate surface to relocate
// legacy routes to the way the desktop sidebar's "Developer / Legacy" section does — dropping them
// from this bar entirely would leave /bot-decisions and /decision-intelligence unreachable from
// any mobile control (review fix: mobile and desktop navigation must remain coherent). They are
// appended after the primary group, past a visual divider, in the same muted treatment desktop
// uses — still de-emphasized relative to primary items, never deleted or hidden outright. See
// docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md.
const primaryNavItems = navItems.filter((item) => item.group !== "legacy");
const legacyNavItems = navItems.filter((item) => item.group === "legacy");

export function Topbar() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 flex flex-col border-b border-base-700 bg-base-950/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-3 md:px-8">
        <div className="flex items-center gap-2 text-sm text-ink-400">
          <DotIcon
            className={marketStatus.isOpen ? "text-accent-teal" : "text-ink-500"}
          />
          <span className="text-ink-100">{marketStatus.label}</span>
          <span className="hidden text-ink-500 sm:inline">&middot; {marketStatus.nextEvent}</span>
        </div>

        <Badge className="border-accent-amber/30 bg-accent-amber/10 text-accent-amber">
          Paper Trading
        </Badge>
      </div>

      <nav
        aria-label="Main"
        className="flex gap-1 overflow-x-auto border-t border-base-700 px-3 py-2 scrollbar-thin md:hidden"
      >
        {primaryNavItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex min-h-11 shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 ${
                isActive ? "bg-base-800 text-ink-100" : "text-ink-400 hover:text-ink-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}

        {legacyNavItems.length > 0 ? (
          <>
            <span aria-hidden="true" className="mx-1 my-1.5 w-px shrink-0 bg-base-700" />
            {legacyNavItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={`flex min-h-11 shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 ${
                    isActive ? "bg-base-800 text-ink-200" : "text-ink-600 hover:text-ink-300"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </>
        ) : null}
      </nav>
    </header>
  );
}
