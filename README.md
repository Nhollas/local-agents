# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches multiple repos for labelled issues, merges them into an oldest-first queue, creates isolated workspaces, and runs Claude agents to do the work.

See [docs/architecture.md](docs/architecture.md) for the full architecture and design decisions.

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

For GitLab-hosted code, use `kind: gitlab`; `base_url` is optional and defaults
to `https://gitlab.com`:

```yaml
code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  repos:
    - your-group/your-project
```

Create `workflow.yaml` in the local-agents working directory to define hooks and
the prompt used for every configured repo:

```yaml
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

1. Add the repo to the `code_host.repos` list in `config.yaml`
2. Create the label (e.g., `agent`) on the repo:
   ```bash
   gh label create agent --repo your-org/your-repo
   ```
3. Restart the orchestrator — it loads `./workflow.yaml` on startup

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

## Requirements

- Node.js >= 22.6.0
- pnpm
- `gh` CLI (authenticated)
- Claude Code (logged in with active subscription)
