# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches Jira for triggered issues, resolves the target repo from each issue's `repo:` label, creates an isolated workspace, and runs a Claude agent to do the work. Jira is the supported tracker, and either GitHub or GitLab can be configured as the code host.

- [docs/architecture.md](docs/architecture.md) — how the system works.
- [docs/configuration.md](docs/configuration.md) — `config.yaml` and `workflow.yaml` reference.

## Setup

```bash
pnpm install
cp .env.example .env
cp config.example.yaml config.yaml
```

Fill in `JIRA_EMAIL`, `JIRA_API_TOKEN`, and either `GITHUB_TOKEN` or `GITLAB_TOKEN` to match the configured code host.

The Agent SDK uses your existing Claude Code login automatically. Make sure you're logged into Claude Code with an active subscription.

Edit `config.yaml` (gitignored — local to your machine) to point at your Jira project and the user or organisation scopes the orchestrator is allowed to clone from. Create `workflow.yaml` in the local-agents working directory to define branch naming, the steps the agent runs, and the change-request template. See [docs/configuration.md](docs/configuration.md) for the full schemas, and [`examples/`](examples) for ready-to-copy starting points.

## Running

```bash
pnpm dev
```

This starts:

- **Orchestrator** on `http://localhost:3000`. Polls Jira, runs agents, and serves the API.
- **Dashboard** on `http://localhost:5173`. Live monitoring over SSE.

## Creating Work

Add the configured `tracker.trigger_label` (for example `local-agents`) to a Jira issue, attach a `repo:<scope>/<name>` label that points at one of your configured code-host scopes, and move it into the configured `pending` status. The orchestrator picks it up on the next tick (default: 30 seconds), clones the repo, runs the workflow, and pushes a branch with a pull or merge request. Transition the issue out of `pending` (or close it) to stop the agent.

The fastest way to create or transition issues:

- **Jira web UI.** Universal, no setup.
- **Atlassian MCP.** If you're driving from Claude Code, install the Atlassian MCP server and ask Claude to create or transition issues directly.
- **`jira` CLI.** Atlassian's official CLI if you'd rather stay in the terminal.

Jira issue keys use native Jira format, for example `PROJ-42`.

## Dashboard

The dashboard shows all agent runs in real-time:

- Live connection status over SSE.
- Runs grouped by agent, with issue key and title.
- Drill into a run to see tool-use activity.
- Kill running agents.
- Dark and light themes.

## Requirements

- Node.js >= 22.6.0
- pnpm
- Claude Code (logged in with active subscription)
- `JIRA_EMAIL` and `JIRA_API_TOKEN`
- `GITHUB_TOKEN` or `GITLAB_TOKEN`, depending on the configured code host
