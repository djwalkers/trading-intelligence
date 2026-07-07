interface PageHeaderProps {
  title: string;
  description: string;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold tracking-tight text-ink-100">{title}</h1>
      <p className="text-sm text-ink-400">{description}</p>
    </div>
  );
}
