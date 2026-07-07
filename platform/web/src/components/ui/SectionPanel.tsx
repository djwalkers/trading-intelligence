import Link from "next/link";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "@/components/icons";

interface SectionPanelProps {
  title: string;
  description?: string;
  viewAllHref?: string;
  children: ReactNode;
}

export function SectionPanel({ title, description, viewAllHref, children }: SectionPanelProps) {
  return (
    <div className="panel flex flex-col">
      <div className="panel-header">
        <div>
          <h2 className="text-sm font-semibold text-ink-100">{title}</h2>
          {description ? <p className="mt-0.5 text-xs text-ink-500">{description}</p> : null}
        </div>
        {viewAllHref ? (
          <Link
            href={viewAllHref}
            className="flex items-center gap-1 text-xs font-medium text-ink-400 transition-colors hover:text-ink-100"
          >
            View all
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </Link>
        ) : null}
      </div>
      {children}
    </div>
  );
}
