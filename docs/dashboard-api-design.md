# Dashboard API Design

Status: **proposal — under review.** Target consumer is the redesigned dashboard prototyped in `dashboard-prototypes/05-system.html`. This doc is the success criteria: when the API matches what's below, the dashboard can be wired up against it without further data-shape negotiation.

The current API (`server/api/api.ts`) is too thin for the new design — no aggregates, no queue/concurrency exposure, no rich tool-event payloads, no per-run cost/branch/PR fields, no ordered step list. This proposal is a breaking redesign; pre-launch, no compat shims.

## Goals

1. **Workflow-agnostic.** The dashboard renders whatever steps the backend reports, in order, with state. It must not hardcode step names or count.
2. **One stream, many polls.** Live run/transcript activity flows over a single SSE firehose. Aggregates (overview strip) come from REST polling.
3. **Backend does the shaping.** Tool-use events are typed and pre-formatted enough that the frontend renders without re-parsing free-form payloads.
4. **Resource-shaped, not UI-shaped.** Endpoints model entities (runs, queue, stats), not page regions. The dashboard composes the page from those.

## Out of scope

- Auth (single-user local tool).
- Pagination of recent runs (cursor, etc.) — initial limit + filter is enough.
- API versioning — pre-launch.
- Persisting the queue across restarts. Queue is in-memory; on restart it rebuilds as the orchestrator's next tracker tick re-encounters labelled issues.

---

## Decisions taken

| Fork | Decision | Why |
|---|---|---|
| Live-update transport | Single SSE firehose at `/events` with `Last-Event-ID` replay + REST polling for stats | Today's pattern, just richer payloads. Standard SSE reconnect semantics handle blips. |
| Tool-event payloads | Typed discriminated union per tool | Frontend stays dumb; renderer is a switch over `kind`. |
| Workflow stripe model | One ordered `Step[]` per run, sourced 1:1 from workflow.yaml's `steps:` array. Orchestrator-internal work (branch-name generation, workspace prep, change-request publishing) is not a step. | The dashboard renders what the workflow defines, no more. Internal orchestrator transitions surface as field changes on the run record (`branch`, `workspaceDir`, `pr`) and as `system` transcript events with `stepName: null`. |
| Queue persistence | In-memory holding queue inside the orchestrator. Queued items have no DB row. | The tracker is the source of truth for "what work exists." On restart the next tick re-encounters labelled issues and refills the queue. Keeps state minimal. |
| Aggregate computation | On-demand SQL per `/stats` request | SQLite at this scale handles it; cheaper than maintaining a snapshot. Revisit if it gets slow. |
| Run detail composition | `GET /runs/:id` returns `{ run, steps }`. Events live behind `GET /runs/:id/events?since=...`. | Detail payload stays bounded. The events list can be thousands of rows on a long completed run; the FE pages it. |
| Snapshot → SSE handoff | Initial fetch returns events with monotonic `seq`. The FE seeds `EventSource`'s `Last-Event-ID` from the last event id it has before connecting `/events`, so the server replays from that cursor. | Same mechanism as reconnect; one code path. |

---

## Resource model

### Run

The central entity. Adds fields the dashboard needs that don't exist today.

```ts
type Run = {
  id: RunId;
  status: "running" | "completed" | "failed";

  repo: RepoSlug;                    // "acme/api"
  branch: string | null;             // "fix/ACME-1284-npm-install-hang" — set once the branch name is resolved
  workspaceDir: string | null;       // "/tmp/lag/9f3b2e1" — set once the workspace is prepared

  issueKey: IssueKey | null;         // "ACME-1284"
  issueTitle: string | null;
  issueUrl: string | null;           // optional, lets dashboard link out

  startedAt: string;                 // ISO 8601 — runs only exist once started
  completedAt: string | null;
  durationMs: number | null;         // computed at write time. kept on the wire so list views don't recompute per-row.

  // Accumulated per workflow step. Each step's query() result returns cost+tokens;
  // the orchestrator adds them to the run's totals on step completion.
  costUsd: number | null;
  tokensInput: number | null;
  tokensOutput: number | null;

  pr: { repo: string; number: number; url: string; kind: "opened" | "commented" } | null;

  error: string | null;              // failure summary for `failed`
  failedStep: { index: number; name: string } | null;   // the failed step's metadata for `failed`
};
```

The current step is whichever entry in `steps` has `state === "running"`. The FE reads it from there. Between steps — or while the orchestrator is doing its own work (resolving a branch name, preparing the workspace, opening a change request) — `currentStep` is `null` and `branch`/`workspaceDir`/`pr` reflect what's been done.

**Schema additions** (`server/db/schema.ts`):

- `runs.branch`, `runs.workspaceDir`: nullable strings, set as the orchestrator resolves them.
- `runs.costUsd`, `runs.tokensInput`, `runs.tokensOutput`: numerics, accumulated per step.
- `runs.prUrl`, `runs.prNumber`, `runs.prRepo`, `runs.prKind`: nullable, set when the change request is opened.
- New `runSteps` table — `(runId, index, name, state, startedAt, completedAt, durationMs, error)`. Composite PK on `(runId, index)`. Rows are inserted as the orchestrator transitions steps.
- `runEvents.seq`: monotonic autoincrement column, indexed. Used for SSE replay (`Last-Event-ID`).

The status enum stays `running | completed | failed` — queued items have no row.

> **Note on `runStepOutputs`:** The existing `runStepOutputs` table (`server/db/schema.ts:38`) is unchanged. It stores each step's structured *payload* (used by change-request templating). The new `runSteps` table stores step *metadata* (state, timing, error). They join on `(runId, name)`.

### Step

One ordered list per run, drives the workflow stripe. Each step is one entry from workflow.yaml's `steps:` array, in declaration order. For today's workflow (`workflow.yaml`) that's:

`implement → review → summarise`

Orchestrator-internal work — generating the branch name from `workflow.yaml`'s top-level `branch:` block, preparing the workspace, opening the change request from the `change_request:` block — is *not* a step. Those transitions surface as field changes on the run record (`branch`, `workspaceDir`, `pr`) and as `system` transcript events with `stepName: null`.

```ts
type Step = {
  index: number;                     // 1-based, in execution order (matches workflow.yaml `steps:` array order)
  name: string;                      // "implement" | "review" | "summarise" — verbatim from workflow.yaml
  state: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  error: string | null;
};
```

### RunEvent (transcript)

Discriminated union over the SSE firehose. Today's `run:tool_use` carries `{ tool, target }` and the dashboard would have to re-parse it; the new shape pre-renders the fields the UI needs.

```ts
type RunEventBase = {
  id: string;                        // event id (also the SSE Last-Event-ID value)
  seq: number;                       // monotonic, used for replay ordering
  runId: RunId;
  stepName: string | null;           // which step this event belongs to; null for run-level or orchestrator-internal events
  createdAt: string;                 // ISO 8601
};

type RunEvent =
  | RunEventBase & { kind: "run:started";   data: { issueKey: string | null; issueTitle: string | null } }
  | RunEventBase & { kind: "run:completed"; data: { durationMs: number; costUsd: number; tokens: { in: number; out: number } } }
  | RunEventBase & { kind: "run:failed";    data: { error: string; durationMs: number } }

  | RunEventBase & { kind: "step:started";   data: { name: string; index: number; total: number } }
  | RunEventBase & { kind: "step:completed"; data: { name: string; index: number; durationMs: number } }
  | RunEventBase & { kind: "step:failed";    data: { name: string; index: number; error: string; durationMs: number } }

  | RunEventBase & { kind: "agent:say"; data: { text: string } }   // one event per assistant text block from the SDK

  | RunEventBase & { kind: "tool:read"; data: { path: string; lines: number } }
  | RunEventBase & { kind: "tool:edit"; data: { path: string; added: number; removed: number; summary: string } }
  | RunEventBase & { kind: "tool:grep"; data: { pattern: string; path: string; matches: number } }
  | RunEventBase & { kind: "tool:bash"; data: {
      command: string;
      cwd: string | null;
      state: "running" | "exited" | "aborted";
      exitCode: number | null;                    // present when state === "exited"
    } }
  | RunEventBase & { kind: "tool:other"; data: { tool: string; summary: string } }   // catch-all for tools we don't specially render

  | RunEventBase & { kind: "system"; data: { message: string; command: string | null; path: string | null; exitCode: number | null } };
```

Notes:

- `stepName` lets the dashboard render step-divider boundaries off the same stream — no separate channel. Events emitted while the orchestrator is between steps (resolving a branch name, preparing the workspace, opening the change request) carry `stepName: null` and render outside any step group.
- `step:completed.durationMs` is the just-finished step's duration, so the FE can label its stripe cell without diffing timestamps across events.
- `tool:bash` has explicit `state` — the blinking cursor renders only when `state === "running"`. `aborted` is rendered with a distinct marker so a hung command and a killed command don't look identical.
- `tool:other` keeps the schema closed without forcing a typed entry for every tool we add — frontend renders generically.
- `agent:say` is emitted once per assistant text block from the SDK (reasoning, narration, plain text). One block, one event.
- `seq` is server-assigned at insert time and never reused. The SSE `Last-Event-ID` field carries the event `id`; the server resolves it to a `seq` for replay.

### Stats (overview strip)

Computed on demand, refreshed by FE polling.

```ts
type Stats = {
  asOf: string;                                     // ISO 8601, server clock
  running: { active: number; max: number };         // "3 / 5"
  queued: { count: number };
  last24h: {
    completed: number; completedDelta: number;     // delta vs prior 24h window
    failed: number;   successRate: number;          // 0..1
    spendUsd: number; spendDeltaUsd: number;
    p50DurationMs: number;
    p95DurationMs: number;
    durationSparkline: number[];                    // last 10 completed run durations, oldest → newest, ms
  };
};
```

Sparkline is raw durations; the FE picks bar heights.

### QueueSnapshot (left column)

```ts
type QueueSnapshot = {
  active: ActiveRun[];                              // running runs from the DB
  queued: QueuedItem[];                             // in-memory queue entries; not yet a Run
};

type ActiveRun = Run & {
  currentStep: { name: string; index: number; total: number } | null;   // null while between steps or during orchestrator-internal work
  progressRatio: number;                            // 0..1 — monotonic indicator of position through the run, used to draw the queue-row progress bar. Server picks the formula; today: (completedSteps + (currentStep ? 0.5 : 0)) / totalSteps.
};

// Materialised from the orchestrator's in-memory holding queue. No DB row, no run id.
type QueuedItem = {
  issueKey: string;
  issueTitle: string;
  repo: RepoSlug;
  pendingSince: string;                             // ISO 8601, when the orchestrator first observed this labelled issue this session. Resets on server restart.
};
```

`progressRatio` is server-side because the FE shouldn't have to fetch all steps for every active row just to draw a bar.

---

## HTTP endpoints

| Method | Path | Returns | Notes |
|---|---|---|---|
| `GET` | `/runs` | `Run[]` | Filters: `status` (`running` \| `completed` \| `failed`), `repo`, `limit` (1..200, default 50). Ordered by `startedAt desc`. |
| `GET` | `/runs/:id` | `{ run: Run; steps: Step[] }` | Run shell + step list, no events. The centre column renders the banner and workflow stripe from this. |
| `GET` | `/runs/:id/events` | `RunEvent[]` | Drives the transcript. No params: returns all events for the run, ordered oldest → newest. `since` query (event id) returns events with `seq` strictly greater than that cursor's `seq` — used for catch-up after a disconnect. |
| `POST` | `/runs/:id/kill` | `{ killed: boolean }` | Same as today. |
| `GET` | `/queue` | `QueueSnapshot` | Drives the left column. Cheap query — left-column polling cadence is up to the FE. |
| `GET` | `/stats` | `Stats` | Drives the overview strip. Polling cadence ~5s suggested. |
| `GET` | `/health` | unchanged | Existing shape is fine. |

### Streaming

| Path | Frames |
|---|---|
| `GET /events` (SSE) | Per event: `id: <event.id>\nevent: <event.kind>\ndata: <RunEvent JSON>\n\n`. 30s heartbeat comments. No filtering — single firehose, FE buckets by `runId`. |

The SSE `event:` field carries the `RunEvent.kind` discriminator so the FE can attach handlers per type rather than switching inside one `onmessage`. The `id:` field carries the event id so the browser's `EventSource` automatically sends `Last-Event-ID` on reconnect. The server reads that header, looks up its `seq`, and replays everything with `seq > lastSeenSeq` before resuming live frames.

For the initial connect after a page load, the FE first calls `/runs/:id` (run + steps) and `/runs/:id/events` (the latest page of transcript events), then opens `EventSource` to `/events`. It seeds `Last-Event-ID` from the last event id it has so the server replays anything that landed between the REST fetch and the SSE handshake. One mechanism, no race window.

The FE updates its in-memory caches off the firehose and revalidates `/queue` and `/stats` on a timer (the firehose doesn't carry aggregate-shaped frames — that's the trade-off for a simple stream).

### Errors

All endpoints use RFC 7807 problem-details (already in `server/api/problem-details.ts`).

| Endpoint | Status | When |
|---|---|---|
| `GET /runs` | 422 | Invalid filter value (e.g. unknown `status`). Validation failures use the project-wide 422 convention; field errors are returned in the `errors` extension. |
| `GET /runs/:id` | 404 | Run id not found. |
| `GET /runs/:id/events` | 404 | Run id not found. |
| `GET /runs/:id/events` | 400 | `since` cursor refers to an unknown event id. |
| `POST /runs/:id/kill` | 404 | Run id not found. |
| `POST /runs/:id/kill` | 409 | Run is already `completed` or `failed`. |
| `GET /queue` | (no failure modes beyond 5xx) | — |
| `GET /stats` | (no failure modes beyond 5xx) | — |
| `GET /events` | 503 | Server shutting down — closes the stream cleanly. |

---

## Example payloads

### `GET /runs/:id` (running)

```json
{
  "run": {
    "id": "run_9f3b2e1c",
    "status": "running",
    "repo": "acme/api",
    "branch": "fix/ACME-1284-npm-install-hang",
    "workspaceDir": "/tmp/lag/9f3b2e1",
    "issueKey": "ACME-1284",
    "issueTitle": "npm install hangs on linux runners",
    "issueUrl": "https://acme.atlassian.net/browse/ACME-1284",
    "startedAt": "2026-05-09T14:27:56Z",
    "completedAt": null,
    "durationMs": null,
    "costUsd": 0.034,
    "tokensInput": 9800,
    "tokensOutput": 2600,
    "pr": null,
    "error": null,
    "failedStep": null
  },
  "steps": [
    { "index": 1, "name": "implement", "state": "running", "startedAt": "2026-05-09T14:28:19Z", "completedAt": null,                   "durationMs": null, "error": null },
    { "index": 2, "name": "review",    "state": "pending", "startedAt": null,                   "completedAt": null,                   "durationMs": null, "error": null },
    { "index": 3, "name": "summarise", "state": "pending", "startedAt": null,                   "completedAt": null,                   "durationMs": null, "error": null }
  ]
}
```

### `GET /runs/:id/events`

```json
[
  { "id": "evt_01", "seq": 4201, "runId": "run_9f3b2e1c", "stepName": null,        "createdAt": "2026-05-09T14:28:07Z", "kind": "system",       "data": { "message": "ran setup script", "command": ".agent/setup.sh", "path": "/tmp/lag/9f3b2e1", "exitCode": 0 } },
  { "id": "evt_02", "seq": 4202, "runId": "run_9f3b2e1c", "stepName": null,        "createdAt": "2026-05-09T14:28:18Z", "kind": "system",       "data": { "message": "branch resolved", "command": null, "path": null, "exitCode": null } },
  { "id": "evt_03", "seq": 4203, "runId": "run_9f3b2e1c", "stepName": "implement", "createdAt": "2026-05-09T14:28:19Z", "kind": "step:started", "data": { "name": "implement", "index": 1, "total": 3 } },
  { "id": "evt_04", "seq": 4204, "runId": "run_9f3b2e1c", "stepName": "implement", "createdAt": "2026-05-09T14:28:19Z", "kind": "agent:say",    "data": { "text": "reading repo layout to understand the runner setup before changing anything." } },
  { "id": "evt_05", "seq": 4205, "runId": "run_9f3b2e1c", "stepName": "implement", "createdAt": "2026-05-09T14:28:21Z", "kind": "tool:read",    "data": { "path": "scripts/ci/install.sh", "lines": 142 } },
  { "id": "evt_06", "seq": 4206, "runId": "run_9f3b2e1c", "stepName": "implement", "createdAt": "2026-05-09T14:28:34Z", "kind": "tool:edit",    "data": { "path": "scripts/ci/install.sh", "added": 6, "removed": 2, "summary": "guarded postinstall behind CI env" } },
  { "id": "evt_07", "seq": 4207, "runId": "run_9f3b2e1c", "stepName": "implement", "createdAt": "2026-05-09T14:28:45Z", "kind": "tool:bash",    "data": { "command": "CI=true bash scripts/ci/install.sh --dry-run", "cwd": "/tmp/lag/9f3b2e1", "state": "running", "exitCode": null } }
]
```

When the run is live, the FE seeds the SSE `Last-Event-ID` from the most recent event id (`evt_07` here) before opening `/events`, so the firehose only delivers what arrived after this fetch.

### `GET /stats`

```json
{
  "asOf": "2026-05-09T14:32:08Z",
  "running": { "active": 3, "max": 5 },
  "queued": { "count": 7 },
  "last24h": {
    "completed": 142, "completedDelta": 12,
    "failed": 2,      "successRate": 0.986,
    "spendUsd": 4.82, "spendDeltaUsd": 0.42,
    "p50DurationMs": 660000,
    "p95DurationMs": 2280000,
    "durationSparkline": [320000, 510000, 380000, 720000, 590000, 860000, 460000, 920000, 660000, 780000]
  }
}
```

### `GET /queue`

```json
{
  "active": [
    {
      "id": "run_9f3b2e1c", "status": "running",
      "repo": "acme/api", "branch": "fix/ACME-1284-npm-install-hang", "workspaceDir": "/tmp/lag/9f3b2e1",
      "issueKey": "ACME-1284", "issueTitle": "npm install hangs on linux runners", "issueUrl": null,
      "startedAt": "2026-05-09T14:27:56Z", "completedAt": null, "durationMs": null,
      "costUsd": 0.034, "tokensInput": 9800, "tokensOutput": 2600,
      "pr": null, "error": null, "failedStep": null,
      "currentStep": { "name": "implement", "index": 1, "total": 3 },
      "progressRatio": 0.17
    }
  ],
  "queued": [
    { "issueKey": "ACME-1285",   "issueTitle": "500 on /api/runs?limit=0",    "repo": "acme/api",          "pendingSince": "2026-05-09T14:31:42Z" },
    { "issueKey": "WIDGETS-911", "issueTitle": "cover branch-resolver edges", "repo": "widgets/dashboard", "pendingSince": "2026-05-09T14:31:55Z" }
  ]
}
```

---

## What this requires changing

A rough inventory so we can scope the work:

1. **Schema migration** (`server/db/schema.ts`, `drizzle/`):
   - Drop `agent_name` from `runs`.
   - Add `branch`, `workspaceDir`, `costUsd`, `tokensInput`, `tokensOutput`, `prUrl`, `prNumber`, `prRepo`, `prKind` to `runs`.
   - Add a `runSteps` table — `(runId, index, name, state, startedAt, completedAt, durationMs, error)`. Composite PK on `(runId, index)`. Replaces ad-hoc step tracking.
   - `runStepOutputs` is unchanged.
   - Add a `seq` autoincrement column to `runEvents`, indexed.
   - Repoint `runEvents.type` to the new `kind` enum and reshape `data` per discriminator. Drop the old `run:output` / `run:tool_use` shapes.
   - No queue table — queued items live in memory only.

2. **Event bus** (`server/event-bus.ts`):
   - Replace the current union with the new `RunEvent` shape.
   - Add helpers for each tool kind so emitters are typed (no JSON-blob plumbing through the orchestrator).

3. **Orchestrator** (`server/orchestrator/`, `server/runner/`):
   - Introduce an in-memory holding queue between tracker fetch and runner dispatch. Today `dispatchPendingIssues` (`server/orchestrator/orchestrator.ts:188-237`) either dispatches or skips inline; instead, push undispatched pending issues into the queue and dispatch from there. Track first-seen-at per issue across ticks (`pendingSince`). Remove items when dispatched, or when the tracker no longer reports them as pending.
   - Stop populating `agentName` on `AgentJob` and the `runs` row.
   - At run start, build the `Step[]` list directly from workflow.yaml's `steps:` array (today: `implement`, `review`, `summarise`). Insert all steps into `runSteps` as `pending`.
   - Emit `step:started` / `step:completed` / `step:failed` events as each step transitions. Update the corresponding `runSteps` row.
   - For orchestrator-internal work (resolving the branch name, preparing the workspace, opening the change request), set the run record's `branch`, `workspaceDir`, `pr*` fields and emit `system` events with `stepName: null` rather than modelling them as steps.
   - Accumulate `costUsd` / `tokensInput` / `tokensOutput` per step from the SDK result; bump the run record on `step:completed`.
   - Track typed tool-use payloads from the agent SDK rather than `{ tool, target }`. Mark `tool:bash` as `aborted` when the run is killed mid-command.

4. **API handlers** (`server/api/api.ts`):
   - Add `/queue`, `/stats`, `/runs/:id/events`. Update `/runs/:id` to return `{ run, steps }` (no events).
   - Drop the `agent` filter on `/runs`.
   - SSE `/events` reshaped to new `RunEvent`. Honour `Last-Event-ID` on reconnect — replay events with `seq > lastSeenSeq` before resuming live frames.
   - Map all new error conditions to RFC 7807 responses per the table above.

5. **Stats query**:
   - One SQL query joining `runs` over the last 24h window for counts/spend/durations. Keep it in `server/db/` next to the run repository.

6. **Dashboard** (`dashboard/src/`):
   - New hooks: `useStats()`, `useQueue()` (polled), `useRunDetail(id)` (one-shot fetch of `{ run, steps }`), `useRunEvents(id)` (one-shot fetch of `/runs/:id/events` + SSE merge seeded with the last event id).
   - Reshape `useEventStream` to the new event union and merge by `runId`.

---

## Open questions

None outstanding.
