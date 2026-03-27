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
Claim Issue → Create Workspace → Run Agent
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push Result (commits, branches)
```

The orchestrator polls an issue tracker for work, claims issues, creates isolated workspaces, runs Claude agents, and reconciles state. The issue tracker IS the orchestration layer.

## Why Polling Over Webhooks

- **Resilient** — if the service is down, it picks up issues on the next tick. No missed events.
- **Simple** — no Cloudflare tunnel, no webhook signature verification, no public URL needed.
- **Portable** — works behind NATs, VPNs, firewalls. Runs anywhere.

## Why Local

- **Subscription-powered** — uses your existing Claude Code login
- **Your machine, your data** — nothing leaves your control beyond what the agent explicitly pushes
- **Full toolchain available** — the agent has access to git, pnpm, your test suite, everything an engineer has

## How It Works

### 1. Configure a workflow

A `workflow.yaml` defines what to poll, how to run agents, and what hooks to execute:

```yaml
tracker:
  kind: github
  repo: org/repo
  label: agent

agent:
  max_concurrent: 2
  model: claude-sonnet-4-6

prompt: |
  You are working on: {{ issue.title }}
  {{ issue.description }}
```

### 2. The orchestrator loop

Each tick:

1. **Fetch** active issues from the tracker
2. **Reconcile** — if a claimed issue is no longer active, kill the run and release the claim
3. **Dispatch** — for each unclaimed issue (up to `max_concurrent`), create a workspace, run hooks, and start a Claude agent

### 3. Workspaces and hooks

Each issue gets an isolated workspace directory. Lifecycle hooks run shell commands at key points:

- `after_create` — clone the repo, create a branch
- `before_run` — fetch latest, rebase
- `after_run` — push the branch

### 4. The agent

Uses `query()` from the Claude Agent SDK with full tool access. The prompt is rendered from the workflow template with issue context injected.

### 5. Reconciliation

The orchestrator detects when issues are closed/resolved and kills the corresponding agent run. Claims are also released when runs complete or fail.

## Tracker Adapters

The system is designed for multiple tracker backends. Currently supported:

| Tracker | Implementation |
|---------|---------------|
| GitHub Issues | `core/trackers/github.ts` — uses `gh` CLI |

Future adapters: GitLab Issues, Jira.

## Design Principles

- **Issue tracker as orchestration** — no separate task queue or job system
- **Narrow scope** — each agent works on one issue at a time
- **Codebase as source of truth** — agents discover context by reading, not from config
- **Disposable work environments** — clone fresh, work in /tmp, clean up after
- **Same toolchain as engineers** — agents run tests, hooks, and linters the same way you do
