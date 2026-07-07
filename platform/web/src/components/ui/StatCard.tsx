import type { ReactNode } from "react";

interface StatCardProps {
  label: string;
  value: string;
  sublabel?: string;
  subValueClassName?: string;
  valueClassName?: string;
  icon?: ReactNode;
}

export function StatCard({
  label,
  value,
  sublabel,
  subValueClassName = "text-ink-400",
  valueClassName = "text-ink-100",
  icon,
}: StatCardProps) {
  return (
    <div className="panel flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-ink-400">{label}</span>
        {icon ? <span className="text-ink-500">{icon}</span> : null}
      </div>
      <div className="flex flex-col gap-1">
        <span className={`text-2xl font-semibold tracking-tight ${valueClassName}`}>{value}</span>
        {sublabel ? <span className={`text-sm ${subValueClassName}`}>{sublabel}</span> : null}
      </div>
    </div>
  );
}
