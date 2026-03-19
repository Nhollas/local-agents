import { useEventStream } from "./use-event-stream.ts";
import { AgentFeed } from "./AgentFeed.tsx";
import type { Run } from "./types.ts";

export function App() {
  const { runs, connected } = useEventStream("/events");

  // Group runs by agent name
  const agentRuns = new Map<string, Run[]>();
  for (const run of runs.values()) {
    const existing = agentRuns.get(run.agentName) ?? [];
    existing.push(run);
    agentRuns.set(run.agentName, existing);
  }

  // Sort agents alphabetically, sort runs within each agent by startedAt desc
  const sortedAgents = Array.from(agentRuns.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, agentRunList]) => ({
      name,
      runs: agentRunList.sort(
        (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
      ),
    }));

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
        {sortedAgents.length === 0 ? (
          <p className="text-gray-500 text-center py-12">
            No agent activity yet. Waiting for events...
          </p>
        ) : (
          <div className="space-y-6">
            {sortedAgents.map((agent) => (
              <AgentFeed key={agent.name} name={agent.name} runs={agent.runs} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
