# Architecture

A polling orchestrator watches multiple repos for labelled issues, merges them into an oldest-first queue, creates isolated workspaces, and runs Claude agents powered by your existing Claude Code subscription.

```
Issue Tracker (GitHub Issues, GitLab, Jira)
        │
        ▼
Polling Orchestrator (tick every N seconds)
        │
        ▼
Fetch All Repos → Merge → Sort oldest first
        │
        ▼
Label swap → Create Workspace (git clone) → Run Agent
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push Result (commits, branches, pull requests)
```

The issue tracker is the orchestration layer. Polling means the orchestrator is resilient to downtime (it catches up on the next tick), works behind NATs and firewalls, and needs nothing exposed publicly.

## How It Works

### 1. Central config

A `config.yaml` defines which repos to poll and operational defaults:

```yaml
tracker:
  kind: github

code_host:
  kind: github

repos:
  - org/repo-a
  - org/repo-b

defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  model: claude-sonnet-4-6
  workspace_root: /tmp/local-agent-workspaces
```

### 2. Per-repo workflow

Each target repo contains `.agents/workflow.yaml` with the label, hooks, and prompt:

```yaml
label: agent

hooks:
  after_create: |
    git checkout -b agent/issue-{{ issue.number }}
  before_run: |
    git fetch origin main && git rebase origin/main
  after_run: |
    git push -u origin agent/issue-{{ issue.number }}

prompt: |
  You are working on: {{ issue.title }}
  {{ issue.description }}
```

Hooks must use plain git commands, not platform-specific CLI tools. The orchestrator handles cloning via `git clone` before the `after_create` hook runs.

### 3. The orchestrator loop

Each tick:

1. **Fetch** active issues from all repos with cached workflows (concurrent)
2. **Merge** all issues into a single list, sorted oldest-first for cross-repo fairness
3. **Reconcile** — if a previously running issue is no longer active, kill the run
4. **Dispatch** — for each unclaimed issue (up to `max_concurrent`), swap its label to mark it as running, create a workspace, and start a Claude agent

### 4. Label-based state

The orchestrator tracks issue state through label swaps on the issue tracker rather than maintaining its own database of claims:

- `agent` — issue is pending, waiting to be picked up
- `agent:running` — orchestrator has claimed this issue and an agent is working on it
- `agent:awaiting-review` — agent has finished and the result is ready for review

This keeps the issue tracker as the single source of truth for what's happening.

### 5. Workflow caching

The orchestrator fetches `.agents/workflow.yaml` from each repo via the code host adapter at startup. Workflows are cached and refreshed periodically. Repos without a workflow are skipped with a warning. Failed refreshes keep the last-known-good workflow.

### 6. Workspaces and hooks

Each issue gets an isolated workspace directory. The orchestrator runs `git clone` to set up the workspace, then executes lifecycle hooks:

- `after_create` — runs once when workspace is first created (e.g. create a branch)
- `before_run` — runs before each agent execution (e.g. fetch latest, rebase)
- `after_run` — runs after agent completes (e.g. push the branch)

### 7. The agent

Uses `query()` from the Claude Agent SDK with full tool access. The prompt is rendered from the workflow template with issue context injected via `{{ variable.path }}` interpolation.

### 8. Reconciliation

The orchestrator detects when issues are closed or resolved and kills the corresponding agent run. Only repos whose issues were successfully fetched are considered for reconciliation, so transient fetch failures do not kill active runs.

## Adapter Interfaces

The system uses two adapter interfaces to stay decoupled from any specific platform:

- **TrackerAdapter** — fetches active issues from a tracker and manages label state
- **CodeHostAdapter** — fetches files from repos, generates clone URLs, and creates pull requests

Both are currently implemented for GitHub (via the `gh` CLI and API). Adding support for another platform means implementing these two interfaces.

## Design Principles

- **Issue tracker as orchestration** — no separate task queue or job system. The tracker is the source of truth for what work exists and what state it's in.
- **Multi-repo, single orchestrator** — one process polls all configured repos with a shared concurrency pool, keeping deployment and configuration simple.
- **Cross-repo fairness** — issues are merged into a single queue so no repo starves another.
- **Narrow scope** — each agent works on one issue at a time in an isolated workspace.
- **Codebase as context** — agents discover what they need by reading the repo, not from configuration passed to them.
- **Disposable work environments** — clone fresh, work in /tmp, clean up after.
- **Same toolchain as engineers** — agents run tests, hooks, and linters the same way you would.
- **Plain git hooks** — no platform-specific commands in repo workflows, keeping them portable across code hosts.
