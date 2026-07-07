import type { SystemService } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { serviceStateClasses, serviceStateLabel } from "@/lib/utils/style";

interface SystemHealthListProps {
  services: SystemService[];
}

export function SystemHealthList({ services }: SystemHealthListProps) {
  return (
    <div className="divide-y divide-base-700/60">
      {services.map((service) => (
        <div key={service.id} className="flex items-center justify-between gap-4 px-5 py-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-ink-100">{service.name}</span>
            <span className="text-xs text-ink-500">{service.detail}</span>
          </div>
          <Badge className={serviceStateClasses(service.state)}>
            {serviceStateLabel(service.state)}
          </Badge>
        </div>
      ))}
    </div>
  );
}
