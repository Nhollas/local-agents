# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches a configured repo for Jira issues in a configured status, creates an isolated workspace per issue, and runs a Claude agent to do the work. Currently the orchestrator supports Jira as the tracker and GitLab as the code host.

See [docs/architecture.md](docs/architecture.md) for how it works and the full `config.yaml` and `workflow.yaml` schemas.

## Setup

```bash
pnpm install
cp .env.example .env
```

Fill in `JIRA_EMAIL`, `JIRA_API_TOKEN`, and `GITLAB_TOKEN`.

The Agent SDK uses your existing Claude Code login automatically. Make sure you're logged into Claude Code with an active subscription.

Edit `config.yaml` to point at your Jira project, your GitLab instance, and the target repo the orchestrator may clone and open merge requests against. Create `workflow.yaml` in the local-agents working directory to define the prompt, hooks, and branch naming. See [docs/architecture.md](docs/architecture.md) for the full schemas and examples.

## Running

```bash
pnpm dev
```

This starts:

- **Orchestrator** on `http://localhost:3000` — polls Jira, runs agents, serves API
- **Dashboard** on `http://localhost:5173` — live monitoring via SSE

## Creating Work

Move (or create) a Jira issue into the configured `pending` status. The orchestrator picks it up on the next tick (default: 30 seconds), clones the repo, runs the agent, and pushes a branch with a merge request. Transition the issue out of `pending` (or close it) to stop the agent.

The fastest way to create or transition issues:

- **Jira web UI** — universal, no setup.
- **Atlassian MCP** — if you're driving from Claude Code, install the Atlassian MCP server and ask Claude to create or transition issues directly.
- **`jira` CLI** — Atlassian's official CLI if you'd rather stay in the terminal.

Jira issue keys use native Jira format, for example `PROJ-42`.

## Dashboard

The dashboard shows all agent runs in real-time:

- Live connection status via SSE
- Runs grouped by agent with issue key and title
- Drill into run details to see tool use activity
- Kill running agents
- Dark/light theme

## Requirements

- Node.js >= 22.6.0
- pnpm
- Claude Code (logged in with active subscription)
- `JIRA_EMAIL` and `JIRA_API_TOKEN`
- `GITLAB_TOKEN`
