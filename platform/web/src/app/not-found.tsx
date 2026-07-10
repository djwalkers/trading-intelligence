import Link from "next/link";

export default function NotFound() {
  return (
    <div className="panel flex flex-col items-start gap-3 p-8">
      <h1 className="text-lg font-semibold text-ink-100">Page not found</h1>
      <p className="text-sm text-ink-400">The page you were looking for does not exist.</p>
      <Link
        href="/"
        className="rounded-md text-sm font-medium text-accent-teal hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
      >
        Back to dashboard
      </Link>
    </div>
  );
}
