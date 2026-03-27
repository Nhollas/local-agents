# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches for labeled issues, claims them, creates isolated workspaces, and runs Claude agents to do the work.

See [docs/pattern.md](docs/pattern.md) for the full pattern documentation.

## Setup

```bash
pnpm install
cp .env.example .env
```

### Authentication

The Agent SDK uses your existing Claude Code login automatically. Make sure you're logged into Claude Code with an active subscription.

### Workflow Configuration

Edit `workflow.yaml` to point at your target repo:

```yaml
tracker:
  kind: github
  repo: your-org/your-repo
  label: agent

prompt: |
  You are working on: {{ issue.title }}
  {{ issue.description }}
```

See [workflow.yaml](workflow.yaml) for the full default configuration with all options.

## Running

```bash
pnpm dev
```

This starts:
- **Orchestrator** on `http://localhost:3000` — polls for issues, runs agents, serves API
- **Dashboard** on `http://localhost:5173` — live monitoring via SSE

### Creating Work

1. Create the `agent` label on your target repo:
   ```bash
   gh label create agent --repo your-org/your-repo
   ```

2. Open an issue with the `agent` label:
   ```bash
   gh issue create --repo your-org/your-repo --title "Add feature X" --label agent
   ```

3. The orchestrator picks it up on the next tick (default: 30 seconds), clones the repo, runs the agent, and pushes a branch.

4. Close the issue to stop the agent.

## Dashboard

The dashboard shows all agent runs in real-time:
- Live connection status via SSE
- Runs grouped by agent with issue key and title
- Drill into run details to see tool use activity
- Kill running agents
- Dark/light theme

## Architecture

```
workflow.yaml → Orchestrator → GitHub Issues (poll)
                    │
                    ▼
              Claim → Workspace → Claude Agent SDK
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
| Orchestrator | `core/orchestrator.ts` | Polling loop with reconciliation |
| Tracker | `core/trackers/github.ts` | GitHub Issues adapter via `gh` CLI |
| Workflow | `core/workflow.ts` | YAML config parser with template rendering |
| Workspace | `core/workspace.ts` | Isolated workspace management with hooks |
| Runner | `core/runner.ts` | Job queue with persistence and SSE events |
| API | `core/api.ts` | Hono server for dashboard endpoints |

## Requirements

- Node.js >= 22.6.0
- pnpm
- `gh` CLI (authenticated)
- Claude Code (logged in with active subscription)
