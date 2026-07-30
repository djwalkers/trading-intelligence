"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { navItems, type NavItem } from "@/components/layout/nav-items";
import { useAuth } from "@/lib/auth/auth-context";
import { APP_VERSION } from "@/lib/version";

// Legacy-worker UI cleanup. A single shared row renderer for both the primary and legacy/developer
// nav groups — `muted` only changes visual weight (smaller text, dimmer default colour), never
// which route is reachable. See docs/audit/LEGACY_WORKER_IMPACT_ASSESSMENT.md.
function NavRow({ item, isActive, muted }: { item: NavItem; isActive: boolean; muted?: boolean }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      aria-current={isActive ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-lg px-3 py-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 ${
        muted ? "text-xs" : "text-sm"
      } ${
        isActive
          ? "bg-base-800 text-ink-100"
          : muted
            ? "text-ink-500 hover:bg-base-800/60 hover:text-ink-200"
            : "text-ink-400 hover:bg-base-800/60 hover:text-ink-100"
      }`}
    >
      <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-accent-teal" : ""}`} />
      {item.label}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { isConfigured, user, signOut } = useAuth();
  const router = useRouter();

  // Phase 2 — Research is the first section with sub-pages (/research/[runId],
  // /research/strategies); an exact match alone would leave the sidebar item unhighlighted on
  // those pages. startsWith(item.href + "/") generalises correctly for any future nested section
  // too, and changes nothing for every existing flat route, none of which have children to match
  // against.
  function isItemActive(item: NavItem): boolean {
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  }

  const primaryItems = navItems.filter((item) => item.group !== "legacy");
  const legacyItems = navItems.filter((item) => item.group === "legacy");

  async function handleSignOut() {
    await signOut();
    router.replace("/sign-in");
  }

  return (
    <aside className="hidden w-56 shrink-0 flex-col border-r border-base-700 bg-base-900 md:flex xl:w-64">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-teal/10 text-accent-teal">
          <span className="text-xs font-semibold">TI</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-semibold text-ink-100">Trading Intelligence</span>
          <span className="text-[11px] text-ink-500">Paper trading platform</span>
        </div>
      </div>

      <nav aria-label="Main" className="flex flex-1 flex-col gap-0.5 overflow-y-auto px-3">
        {primaryItems.map((item) => (
          <NavRow key={item.href} item={item} isActive={isItemActive(item)} />
        ))}

        {legacyItems.length > 0 ? (
          <div className="mt-4 flex flex-col gap-0.5" data-testid="sidebar-legacy-group">
            <span className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-600">
              Developer / Legacy
            </span>
            {legacyItems.map((item) => (
              <NavRow key={item.href} item={item} isActive={isItemActive(item)} muted />
            ))}
          </div>
        ) : null}
      </nav>

      {isConfigured && user ? (
        <div className="border-t border-base-700 px-4 py-3">
          <p className="truncate text-xs text-ink-400" title={user.email ?? undefined}>
            {user.email}
          </p>
          <button
            type="button"
            onClick={handleSignOut}
            className="mt-1.5 rounded-md text-xs font-medium text-ink-500 transition-colors hover:text-ink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
          >
            Sign out
          </button>
        </div>
      ) : null}

      <div className="border-t border-base-700 px-4 py-4">
        <p className="text-xs leading-relaxed text-ink-500">
          Build {APP_VERSION}
          <br />
          Paper trading only. No live trading.
        </p>
      </div>
    </aside>
  );
}
