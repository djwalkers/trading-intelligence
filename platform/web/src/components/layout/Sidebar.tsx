"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { navItems } from "@/components/layout/nav-items";
import { useAuth } from "@/lib/auth/auth-context";

export function Sidebar() {
  const pathname = usePathname();
  const { isConfigured, user, signOut } = useAuth();
  const router = useRouter();

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
          <span className="text-[11px] text-ink-500">Prototype workspace</span>
        </div>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.icon;

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-base-800 text-ink-100"
                  : "text-ink-400 hover:bg-base-800/60 hover:text-ink-100"
              }`}
            >
              <Icon className={`h-3.5 w-3.5 shrink-0 ${isActive ? "text-accent-teal" : ""}`} />
              {item.label}
            </Link>
          );
        })}
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
        <p className="text-xs leading-relaxed text-ink-600">
          Build 1.3.0 &middot; Mission 6
          <br />
          Mock or external prices. No live trading.
        </p>
      </div>
    </aside>
  );
}
