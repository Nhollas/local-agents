# Pattern: Polling Orchestrator

Run AI agents on your machine, triggered by issue trackers, using your Claude subscription. No API billing, no cloud infrastructure, no webhooks.

## The Pattern

```
Issue Tracker (GitHub Issues, GitLab, Jira)
        │
        ▼
Polling Orchestrator (tick every N seconds)
        │
        ▼
Fetch All Repos → Merge → Sort by createdAt (oldest first)
        │
        ▼
Claim Issue → Create Workspace (git clone) → Run Agent
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push Result (commits, branches)
```

The orchestrator polls multiple repos for labeled issues, merges them into a single queue sorted oldest-first, creates isolated workspaces, runs Claude agents, and reconciles state. The issue tracker IS the orchestration layer.

## Why Polling Over Webhooks

- **Resilient** — if the service is down, it picks up issues on the next tick. No missed events.
- **Simple** — no Cloudflare tunnel, no webhook signature verification, no public URL needed.
- **Portable** — works behind NATs, VPNs, firewalls. Runs anywhere.

## Why Local

- **Subscription-powered** — uses your existing Claude Code login
- **Your machine, your data** — nothing leaves your control beyond what the agent explicitly pushes
- **Full toolchain available** — the agent has access to git, pnpm, your test suite, everything an engineer has

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

Hooks must use plain git commands — no platform-specific CLI tools. The orchestrator handles cloning via `git clone <cloneUrl>` before the `after_create` hook runs.

### 3. The orchestrator loop

Each tick:

1. **Fetch** active issues from all repos with cached workflows (concurrent)
2. **Merge** all issues into a single list, sorted by `createdAt` ascending (oldest first)
3. **Reconcile** — if a claimed issue is no longer active, kill the run and release the claim
4. **Dispatch** — for each unclaimed issue (up to `max_concurrent`), create a workspace, run hooks, and start a Claude agent

### 4. Workflow caching

The orchestrator fetches `.agents/workflow.yaml` from each repo via the `CodeHostAdapter` at startup. Workflows are cached and refreshed every 10 minutes. Repos without a workflow are skipped with a warning. Failed refreshes keep the last-known-good workflow.

### 5. Workspaces and hooks

Each issue gets an isolated workspace directory. The orchestrator runs `git clone <cloneUrl> .` to set up the workspace, then executes lifecycle hooks:

- `after_create` — create a branch (runs once when workspace is first created)
- `before_run` — fetch latest, rebase (runs before each agent execution)
- `after_run` — push the branch (runs after agent completes)

### 6. The agent

Uses `query()` from the Claude Agent SDK with full tool access. The prompt is rendered from the workflow template with issue context injected via `{{ variable.path }}` interpolation.

### 7. Reconciliation

The orchestrator detects when issues are closed/resolved and kills the corresponding agent run. Only repos whose issues were successfully fetched are considered for reconciliation — transient fetch failures do not kill active runs. Claims are also released when runs complete or fail.

## Adapter Interfaces

### TrackerAdapter

```typescript
type TrackerAdapter = {
  fetchActiveIssues(repo: string, label: string): Promise<Issue[]>;
};
```

One instance per platform, parameterized per call. Currently implemented for GitHub Issues via the `gh` CLI.

### CodeHostAdapter

```typescript
type CodeHostAdapter = {
  fetchFile(repo: string, path: string, ref?: string): Promise<string | null>;
  cloneUrl(repo: string): string;
};
```

Used to fetch `.agents/workflow.yaml` from repos and generate clone URLs. Currently implemented for GitHub via the `gh` API.

## Design Principles

- **Issue tracker as orchestration** — no separate task queue or job system
- **Multi-repo, single orchestrator** — one process polls all configured repos with a shared concurrency pool
- **Oldest first** — cross-repo fairness via `createdAt` sorting
- **Narrow scope** — each agent works on one issue at a time
- **Codebase as source of truth** — agents discover context by reading, not from config
- **Disposable work environments** — clone fresh, work in /tmp, clean up after
- **Same toolchain as engineers** — agents run tests, hooks, and linters the same way you do
- **Plain git hooks** — no platform-specific commands in repo workflows
