import type { DecisionDifference } from "@/lib/hermes-execution/research/types";
import { formatDateTime } from "@/lib/utils/format";

export function DecisionDifferencesTable({ differences, labelA, labelB }: { differences: DecisionDifference[]; labelA: string; labelB: string }) {
  if (differences.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No decision differences — both strategies decided identically at every historical point in this window.</p>;
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-base-700/60 text-ink-500">
            <th scope="col" className="px-4 py-2 font-medium">
              When
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {labelA}
            </th>
            <th scope="col" className="px-4 py-2 font-medium">
              {labelB}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {differences.map((diff) => (
            <tr key={diff.analysisRunId} className="text-ink-300">
              <td className="px-4 py-2 text-ink-500">{formatDateTime(diff.timestamp)}</td>
              <td className="px-4 py-2">{diff.actionA}</td>
              <td className="px-4 py-2">{diff.actionB}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
