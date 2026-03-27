# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches multiple repos for labeled issues, merges them into an oldest-first queue, creates isolated workspaces, and runs Claude agents to do the work.

See [docs/pattern.md](docs/pattern.md) for the full pattern documentation.

## Setup

```bash
pnpm install
cp .env.example .env
```

### Authentication

The Agent SDK uses your existing Claude Code login automatically. Make sure you're logged into Claude Code with an active subscription.

### Configuration

Edit `config.yaml` to list your target repos:

```yaml
tracker:
  kind: github

code_host:
  kind: github

repos:
  - your-org/your-repo

defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  model: claude-sonnet-4-6
  workspace_root: /tmp/local-agent-workspaces
```

Each target repo needs a `.agents/workflow.yaml` that defines the label, hooks, and prompt:

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

## Running

```bash
pnpm dev
```

This starts:
- **Orchestrator** on `http://localhost:3000` — polls for issues, runs agents, serves API
- **Dashboard** on `http://localhost:5173` — live monitoring via SSE

### Adding a New Repo

1. Add the repo to the `repos` list in `config.yaml`
2. Commit `.agents/workflow.yaml` to the repo with label, hooks, and prompt
3. Create the label (e.g., `agent`) on the repo:
   ```bash
   gh label create agent --repo your-org/your-repo
   ```
4. Restart the orchestrator — it fetches workflows on startup

### Creating Work

1. Open an issue with the configured label:
   ```bash
   gh issue create --repo your-org/your-repo --title "Add feature X" --label agent
   ```

2. The orchestrator picks it up on the next tick (default: 30 seconds), clones the repo, runs the agent, and pushes a branch.

3. Close the issue to stop the agent.

## Dashboard

The dashboard shows all agent runs in real-time:
- Live connection status via SSE
- Runs grouped by agent with repo-qualified issue key and title
- Drill into run details to see tool use activity
- Kill running agents
- Dark/light theme

## Architecture

```
config.yaml → Orchestrator → GitHub Issues (poll all repos)
                   │
                   ▼
             Merge + Sort (oldest first)
                   │
                   ▼
             Claim → Workspace (git clone) → Claude Agent SDK
                   │
                   ▼
             Runner (queue + persistence + SSE)
                   │
                   ▼
             Dashboard (React + Tailwind)
```

### Key Components

| Component | File | Purpose |
|-----------|------|---------|
| Orchestrator | `core/orchestrator.ts` | Multi-repo polling with oldest-first dispatch |
| Tracker | `core/trackers/github.ts` | GitHub Issues adapter via `gh` CLI |
| Code Host | `core/code-hosts/github.ts` | GitHub file fetching and clone URLs |
| Config | `core/config.ts` | Central `config.yaml` parser |
| Workflow | `core/workflow.ts` | Per-repo workflow parser with template rendering |
| Workflow Cache | `core/workflow-cache.ts` | Fetches and caches `.agents/workflow.yaml` from repos |
| Workspace | `core/workspace.ts` | Isolated workspace management with git clone and hooks |
| Runner | `core/runner.ts` | Job queue with persistence and SSE events |
| API | `core/api.ts` | Hono server for dashboard endpoints |

### Adapter Interfaces

| Interface | Purpose | Implementations |
|-----------|---------|----------------|
| `TrackerAdapter` | Fetch active issues from a tracker | GitHub (`gh` CLI) |
| `CodeHostAdapter` | Fetch files and clone URLs from repos | GitHub (`gh` API) |

## Requirements

- Node.js >= 22.6.0
- pnpm
- `gh` CLI (authenticated)
- Claude Code (logged in with active subscription)
