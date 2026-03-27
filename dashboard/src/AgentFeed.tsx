import { useMutation, useQueryClient } from "@tanstack/react-query";
import { killRun } from "./api.ts";
import { formatDuration, formatTime } from "./format.ts";
import { StatusBadge } from "./StatusBadge.tsx";
import type { Run } from "./types.ts";

type Props = {
  name: string;
  runs: Run[];
  onSelectRun: (runId: string) => void;
};

export function AgentFeed({ name, runs, onSelectRun }: Props) {
  const queryClient = useQueryClient();
  const killMutation = useMutation({
    mutationFn: killRun,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
  });

  return (
    <section
      aria-label={name}
      className="rounded-lg border border-border bg-surface-1"
    >
      <div className="px-4 py-3 border-b border-border flex items-center justify-between">
        <h2 className="font-medium text-sm">{name}</h2>
        <span className="text-xs text-text-muted">{runs.length} run(s)</span>
      </div>
      <div className="divide-y divide-border">
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
              <span className="text-xs text-text-muted font-mono">
                {run.id}
              </span>
              {run.issueTitle && (
                <span className="text-xs text-text-secondary truncate">
                  {run.issueKey ? `${run.issueKey}: ` : ""}{run.issueTitle}
                </span>
              )}
            </button>
            <div className="flex items-center gap-4 text-xs text-text-secondary shrink-0">
              <span>{formatDuration(run.durationMs)}</span>
              <span>{formatTime(run.startedAt)}</span>
              {run.status === "running" && (
                <button
                  type="button"
                  aria-label={`Kill run ${run.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    killMutation.mutate(run.id);
                  }}
                  className="px-2 py-0.5 rounded border border-error-border bg-error-muted text-error hover:brightness-125 transition-all"
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
