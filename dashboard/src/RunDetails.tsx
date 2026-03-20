import { useEffect, useState } from "react";
import { formatDuration } from "./format.ts";
import type { Run } from "./types.ts";

type RunEventFromApi = {
  id: string;
  runId: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
};

type RunDetailFromApi = Run & {
  events: RunEventFromApi[];
};

type Props = {
  run: Run;
  onBack: () => void;
};

export function RunDetails({ run, onBack }: Props) {
  const [events, setEvents] = useState<RunEventFromApi[]>([]);

  useEffect(() => {
    fetch(`/runs/${run.id}`)
      .then((res) => res.json())
      .then((data: RunDetailFromApi) => {
        setEvents(data.events ?? []);
      })
      .catch(() => {});
  }, [run.id]);

  const statusColor = {
    running: "text-blue-400",
    completed: "text-green-400",
    failed: "text-red-400",
  }[run.status];

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="text-sm text-gray-400 hover:text-gray-200 mb-4"
      >
        &larr; Back to feed
      </button>

      <div className="rounded-lg border border-gray-800 bg-gray-900 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">{run.agentName}</h2>
          <span className={`text-sm font-medium ${statusColor}`}>
            {run.status}
          </span>
        </div>

        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="text-gray-500">Run ID</dt>
          <dd className="font-mono text-xs">{run.id}</dd>
          <dt className="text-gray-500">Started</dt>
          <dd>{new Date(run.startedAt).toLocaleString()}</dd>
          {run.completedAt && (
            <>
              <dt className="text-gray-500">Completed</dt>
              <dd>{new Date(run.completedAt).toLocaleString()}</dd>
            </>
          )}
          <dt className="text-gray-500">Duration</dt>
          <dd>{formatDuration(run.durationMs)}</dd>
        </dl>

        {run.error && (
          <div role="alert" className="rounded border border-red-500/30 bg-red-500/10 p-3">
            <h3 className="text-sm font-medium text-red-400 mb-1">Error</h3>
            <pre className="text-xs text-red-300 whitespace-pre-wrap font-mono">
              {run.error}
            </pre>
          </div>
        )}

        {events.length > 0 && (
          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-2">Events</h3>
            <ol aria-label="Events" className="space-y-1">
              {events.map((ev) => (
                <li
                  key={ev.id}
                  className="flex items-center gap-3 text-xs py-1"
                >
                  <span className="text-gray-500 font-mono w-16 shrink-0">
                    {new Date(ev.createdAt).toLocaleTimeString()}
                  </span>
                  <span className="text-gray-300">{ev.type}</span>
                  {Object.keys(ev.data).length > 0 && (
                    <span className="text-gray-500 truncate">
                      {JSON.stringify(ev.data)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
      </div>
    </div>
  );
}
