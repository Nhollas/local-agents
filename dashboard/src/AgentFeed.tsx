import type { Run } from "./types.ts";

type Props = {
  name: string;
  runs: Run[];
};

function StatusBadge({ status }: { status: Run["status"] }) {
  const styles = {
    running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
    completed: "bg-green-500/20 text-green-400 border-green-500/30",
    failed: "bg-red-500/20 text-red-400 border-red-500/30",
  };

  return (
    <span
      className={`px-2 py-0.5 text-xs font-medium rounded border ${styles[status]}`}
    >
      {status}
    </span>
  );
}

function formatDuration(ms?: number): string {
  if (ms == null) return "...";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

export function AgentFeed({ name, runs }: Props) {
  return (
    <div className="rounded-lg border border-gray-800 bg-gray-900">
      <div className="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
        <h2 className="font-medium text-sm">{name}</h2>
        <span className="text-xs text-gray-500">{runs.length} run(s)</span>
      </div>
      <div className="divide-y divide-gray-800">
        {runs.map((run) => (
          <div
            key={run.id}
            className="px-4 py-3 flex items-center justify-between gap-4"
          >
            <div className="flex items-center gap-3 min-w-0">
              <StatusBadge status={run.status} />
              <span className="text-xs text-gray-500 font-mono">{run.id}</span>
            </div>
            <div className="flex items-center gap-4 text-xs text-gray-400 shrink-0">
              <span>{formatDuration(run.durationMs)}</span>
              <span>{formatTime(run.startedAt)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
