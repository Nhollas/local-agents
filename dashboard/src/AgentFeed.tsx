import { formatDuration, formatTime } from "./format.ts";
import type { Run } from "./types.ts";

type Props = {
  name: string;
  runs: Run[];
  onSelectRun: (runId: string) => void;
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

async function killRun(runId: string) {
  await fetch(`/runs/${runId}/kill`, { method: "POST" });
}

export function AgentFeed({ name, runs, onSelectRun }: Props) {
  return (
    <section aria-label={name} className="rounded-lg border border-gray-800 bg-gray-900">
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
            <button
              type="button"
              aria-label={`View run ${run.id}`}
              onClick={() => onSelectRun(run.id)}
              className="flex items-center gap-3 min-w-0 hover:opacity-80 transition-opacity"
            >
              <StatusBadge status={run.status} />
              <span className="text-xs text-gray-500 font-mono">{run.id}</span>
            </button>
            <div className="flex items-center gap-4 text-xs text-gray-400 shrink-0">
              <span>{formatDuration(run.durationMs)}</span>
              <span>{formatTime(run.startedAt)}</span>
              {run.status === "running" && (
                <button
                  type="button"
                  aria-label={`Kill run ${run.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    killRun(run.id);
                  }}
                  className="px-2 py-0.5 rounded border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors"
                >
                  Kill
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
