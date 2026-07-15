import ReactMarkdown, { type Components } from "react-markdown";

// No Tailwind Typography plugin is installed in this codebase (confirmed — no `prose` classes
// exist anywhere), so react-markdown's default unstyled HTML output would render illegibly against
// this app's dark theme. This maps each markdown element to the same ink-*/base-* utility classes
// already used throughout the rest of the design system, rather than introducing any new visual
// style or a new plugin dependency.
const components: Components = {
  h1: ({ children }) => <h1 className="mb-2 mt-4 text-base font-semibold text-ink-100 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-4 text-sm font-semibold text-ink-100 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-3 text-sm font-medium text-ink-100 first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-2 text-xs leading-relaxed text-ink-300 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 text-xs text-ink-300 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 text-xs text-ink-300 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-ink-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} className="text-accent-teal underline underline-offset-2 hover:text-accent-teal/80">
      {children}
    </a>
  ),
  code: ({ children }) => (
    <code className="rounded bg-base-800 px-1 py-0.5 text-[0.7rem] text-ink-200">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-lg border border-base-700 bg-base-900 p-3 text-[0.7rem] text-ink-200 last:mb-0">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-base-600 pl-3 text-xs italic text-ink-400 last:mb-0">
      {children}
    </blockquote>
  ),
};

interface MarkdownContentProps {
  children: string;
}

export function MarkdownContent({ children }: MarkdownContentProps) {
  return <ReactMarkdown components={components}>{children}</ReactMarkdown>;
}
