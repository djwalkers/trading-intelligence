import { SectionPanel } from "@/components/ui/SectionPanel";

interface EvidenceBulletListProps {
  title: string;
  description?: string;
  items: string[];
  tone?: "supportive" | "risk";
}

export function EvidenceBulletList({
  title,
  description,
  items,
  tone = "supportive",
}: EvidenceBulletListProps) {
  return (
    <SectionPanel title={title} description={description}>
      <ul className="flex flex-col gap-2.5 px-5 py-4">
        {items.map((item, index) => (
          <li key={index} className="flex items-start gap-2.5 text-sm text-ink-300">
            <span
              className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
                tone === "risk" ? "bg-accent-amber" : "bg-ink-500"
              }`}
              aria-hidden="true"
            />
            {item}
          </li>
        ))}
      </ul>
    </SectionPanel>
  );
}
