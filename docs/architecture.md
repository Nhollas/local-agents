# Architecture

A polling orchestrator watches an issue tracker for triggered issues, resolves the target repo, creates an isolated workspace, and runs Claude agents through your existing Claude Code subscription.

For configuration reference, see [configuration.md](configuration.md).

```
Issue Tracker (Jira)
        │
        ▼
Polling Orchestrator (tick every N seconds)
        │
        ▼
Fetch active issues → Resolve repo from labels → Sort oldest first
        │
        ▼
Clone workspace → Resolve branch → Run workflow steps
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push branch → Open change request → Transition tracker
```

The issue tracker is the orchestration layer. Polling has a few useful properties: the orchestrator catches up on its next tick after downtime, it runs happily behind NATs and firewalls, and it exposes nothing publicly.

## Components

The orchestrator is one process composed of a few cooperating pieces.

- **Tracker adapter.** Fetches active issues for a logical state, transitions issue state, and marks issues as failed. Jira is the implemented adapter today.
- **Code-host adapter.** Resolves clone URLs and default branches, and creates the change request. GitHub and GitLab are both implemented.
- **Orchestrator loop.** Ticks on an interval, decides which issues to dispatch, and reconciles tracker state against in-flight work.
- **Run lifecycle.** Owns a single issue's run from clone through tracker transition. Pins lifecycle actions at fixed points around the workflow steps.
- **Runner.** Bounded concurrency pool that owns the run handle, abort signal, and step events for the dashboard.
- **Workflow engine.** Loads and validates `workflow.yaml`, renders prompts with issue and step-output context, expands trusted shell blocks, and invokes the Claude Agent SDK for each step.
- **Run repository.** SQLite-backed store for run history that survives restarts.
- **Dashboard API.** Streams run and step events over SSE so the dashboard can show live activity.

## The Orchestrator Loop

Each tick proceeds through five steps.

1. **Fetch** Jira issues whose status maps to `pending` and which carry the configured `trigger_label`.
2. **Resolve repo** from each issue's `repo:<scope>/<name>` label. Issues without a recognised label are dropped with a logged reason.
3. **Sort** oldest first so issues from different repos compete fairly.
4. **Reconcile.** If a previously running issue is no longer active in the tracker, kill its run.
5. **Dispatch.** For each unclaimed pending issue, up to `max_concurrent`, transition it to `running`, ensure the workspace exists, and start the workflow.

A single tick is serial against itself: a new tick will not start until the previous one finishes. Dispatched runs continue in the background between ticks.

### Logical Tracker State

The orchestrator works in three logical states. The Jira adapter maps each state onto the configured Jira status name, so the orchestrator never has to know about specific Jira status strings.

| Logical state     | Example Jira status |
|-------------------|---------------------|
| `pending`         | `To Do`             |
| `running`         | `In Progress`       |
| `awaiting_review` | `In Review`         |

This keeps the tracker as the single source of truth for what work exists and what state it is in.

### Reconciliation

The orchestrator detects when issues are closed or moved out of an active state and kills the corresponding run. Only repos whose issues were successfully fetched are considered for reconciliation, so transient fetch failures do not kill active runs.

## The Run Lifecycle

Once an issue is dispatched, its run goes through a fixed sequence. Each box below corresponds to a pinned lifecycle action; the workflow steps run inside the middle box.

```
clone → resolve branch → checkout → repo bootstrap → [ workflow steps ] → push → change request → tracker transition
```

### Workspaces

Each issue gets an isolated workspace under `defaults.workspace_root`. The orchestrator clones the repo into it, resolves the branch (either by template or by running the branch-naming agent), checks the branch out, and runs `.agent/setup.sh` from the cloned repo if one is present. Workflow files do not contain `pnpm install` or codegen warm-ups themselves, since the same workflow targets repos with different toolchains. That kind of repo-specific bootstrap lives in the repo itself.

A failing run keeps its workspace on disk so the work can be inspected; a fully successful run removes the workspace once it's done. Success here is the full chain: every step succeeded, the branch was pushed, the change request was opened, and the tracker transition went through.

### Fixed Lifecycle Pins

Step outputs are pure typed data. They flow into later step prompts and into the `change_request` template, but their presence or content never reorders what the orchestrator does. Lifecycle actions fire at fixed pins instead, with the pinned order recorded in [ADR 0001](adr/0001-phase-outputs-and-fixed-lifecycle.md).

1. Run all workflow steps to completion.
2. `git push --force` the branch to origin.
3. Open the change request through the code-host adapter, using the rendered `change_request` template.
4. Transition the tracker issue from `running` to `awaiting_review`.

If any of these fail, the run is marked failed, the workspace is preserved, and the adapter moves the tracker issue into its failed state so it does not get stuck in `running`.

### The Agent

Each workflow step runs through `query()` from the Claude Agent SDK with full tool access. Prompts are rendered from the workflow template with issue and step-output context, then any trusted shell blocks are expanded against the workspace before the prompt reaches the SDK. By default each step starts a fresh Claude session; a step can resume the previous step's session if the workflow asks for it. A step can also force a JSON-Schema-shaped output, which the orchestrator stores under `steps.<name>.output` for use by later prompts and the change-request template.

The full template-language and step-options reference lives in [configuration.md](configuration.md).

## Adapter Interfaces

The system uses two adapters to stay decoupled from any specific platform.

- **TrackerAdapter** fetches active issues, transitions issue state, and marks issues as failed.
- **CodeHostAdapter** resolves clone URLs and default branches, and creates the change request.

Adding another platform means writing the relevant adapter and wiring it into the config-driven factory. The orchestrator itself stays unchanged.

## Recovery

When the process restarts, any runs that were in flight at shutdown are dead. The orchestrator runs a recovery pass before its first tick:

- Runs marked `running` in the run repository are failed with a "stale run" reason.
- Tracker issues stuck in the `running` state are pushed back to `pending` so the next tick re-dispatches them.

Restarting is therefore safe. Anything that was mid-flight is picked up and rerun cleanly on the next tick.

## Design Principles

- **Issue tracker as orchestration.** No separate task queue or job system. The tracker is the source of truth for what work exists.
- **Multi-repo, single orchestrator.** One process polls the configured tracker and dispatches across all in-scope repos with a shared concurrency pool.
- **Cross-repo fairness.** Issues are merged into a single oldest-first queue so no repo starves another.
- **Narrow scope.** Each agent works on one issue at a time in an isolated workspace.
- **Codebase as context.** Agents discover what they need by reading the repo they're working in, so the workflow file stays free of repo-specific facts.
- **Disposable work environments.** Each run clones fresh into `/tmp`, and the workspace is cleaned up after a fully successful run.
- **Same toolchain as engineers.** Agents run tests, linters, and the repo's own bootstrap the same way an engineer working on the repo would.
- **Repo-owned bootstrap.** `.agent/setup.sh` lives in the target repo, which keeps workflows portable across repos with different toolchains.
- **Orchestrator-owned lifecycle.** Push, change-request creation, and tracker transitions fire at fixed pins owned by the orchestrator, so workflow authors don't have to decide when each one runs.
