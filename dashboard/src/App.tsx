import { useMemo, useState } from "react";
import { useEventStream } from "./use-event-stream.ts";
import { useRunHistory } from "./use-run-history.ts";
import { AgentFeed } from "./AgentFeed.tsx";
import { RunDetails } from "./RunDetails.tsx";
import type { Run } from "./types.ts";

export function App() {
  const { runs: liveRuns, connected } = useEventStream("/events");
  const { history } = useRunHistory();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Merge live runs with history — live takes precedence
  const allRuns = useMemo(() => {
    const merged = new Map<string, Run>();
    for (const run of history) {
      merged.set(run.id, run);
    }
    for (const run of liveRuns.values()) {
      merged.set(run.id, run);
    }
    return merged;
  }, [liveRuns, history]);

  // Group runs by agent name
  const sortedAgents = useMemo(() => {
    const agentRuns = new Map<string, Run[]>();
    for (const run of allRuns.values()) {
      const existing = agentRuns.get(run.agentName) ?? [];
      existing.push(run);
      agentRuns.set(run.agentName, existing);
    }

    return Array.from(agentRuns.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, runs]) => ({
        name,
        runs: runs.sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
        ),
      }));
  }, [allRuns]);

  const selectedRun = selectedRunId ? allRuns.get(selectedRunId) : null;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <header className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Agent Dashboard</h1>
        <div className="flex items-center gap-2 text-sm">
          <span
            className={`inline-block w-2 h-2 rounded-full ${connected ? "bg-green-400" : "bg-red-400"}`}
          />
          <span className="text-gray-400">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-8">
        {selectedRun ? (
          <RunDetails
            run={selectedRun}
            onBack={() => setSelectedRunId(null)}
          />
        ) : sortedAgents.length === 0 ? (
          <p className="text-gray-500 text-center py-12">
            No agent activity yet. Waiting for events...
          </p>
        ) : (
          <div className="space-y-6">
            {sortedAgents.map((agent) => (
              <AgentFeed
                key={agent.name}
                name={agent.name}
                runs={agent.runs}
                onSelectRun={setSelectedRunId}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
