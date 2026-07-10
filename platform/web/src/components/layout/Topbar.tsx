"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/components/layout/nav-items";
import { marketStatus } from "@/lib/mock";
import { Badge } from "@/components/ui/Badge";
import { DotIcon } from "@/components/icons";

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

      <nav className="flex gap-1 overflow-x-auto border-t border-base-700 px-3 py-2 scrollbar-thin md:hidden">
        {navItems.map((item) => {
          const isActive = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                isActive ? "bg-base-800 text-ink-100" : "text-ink-400 hover:text-ink-100"
              }`}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
