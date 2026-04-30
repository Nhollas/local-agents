# Local Autonomous Agents

AI agents that run on your machine, triggered by issue trackers, powered by your Claude subscription.

A polling orchestrator watches multiple repos for labelled issues, merges them into an oldest-first queue, creates isolated workspaces, and runs Claude agents to do the work.

See [docs/architecture.md](docs/architecture.md) for the current architecture.
The shell expansion and integration design is tracked in
[docs/design-shell-expansion-and-integrations.md](docs/design-shell-expansion-and-integrations.md)
and the accompanying
[decisions log](docs/design-shell-expansion-and-integrations-decisions.md).

## Setup

```bash
pnpm install
cp .env.example .env
```

### Authentication

The Agent SDK uses your existing Claude Code login automatically. Make sure you're logged into Claude Code with an active subscription.

### Configuration

Edit `config.yaml` to choose one tracker, one code host, and the target repos
the orchestrator may clone and open change requests against.

For GitHub issues with GitHub-hosted code:

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

For Jira tracking, configure native Jira statuses. Jira issues do not identify a
code repo, so Jira mode currently requires exactly one `code_host.repos` entry.
This example uses GitLab-hosted code; `code_host.base_url` is optional and
defaults to `https://gitlab.com`:

```yaml
tracker:
  kind: jira
  base_url: https://yourco.atlassian.net
  project: PROJ
  statuses:
    pending: "To Do"
    running: "In Progress"
    awaiting_review: "In Review"

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
  You are working on: {{ issue.key }} - {{ issue.title }}
  {{ issue.description }}
```

The workflow can also define staged prompts with `phases` instead of `prompt`:

```yaml
phases:
  - name: plan
    prompt: |
      Analyze {{ issue.key }} and write PLAN.md.

  - name: implement
    resume_previous: true
    prompt: |
      Implement PLAN.md.
      !`test -f PLAN.md`
```

Shell blocks written directly in `workflow.yaml` with `` !`command` `` run in
the cloned workspace before the agent prompt is sent. Their stdout replaces the
block. Shell expansion is strict: non-zero exit, timeout, signal termination,
spawn failure, or output overflow fails the run. Issue titles and descriptions
are treated as untrusted content and cannot inject executable shell blocks.

## Running

```bash
pnpm dev
```

This starts:

- **Orchestrator** on `http://localhost:3000` — polls for issues, runs agents, serves API
- **Dashboard** on `http://localhost:5173` — live monitoring via SSE

### Adding a New GitHub Repo

1. Add the repo to the `code_host.repos` list in `config.yaml`
2. Create the required state labels on the repo:
   ```bash
   gh label create agent --repo your-org/your-repo
   gh label create agent:running --repo your-org/your-repo
   gh label create agent:awaiting-review --repo your-org/your-repo
   ```
3. Restart the orchestrator - it loads `./workflow.yaml` on startup

### Creating GitHub Work

1. Open an issue with the configured label:

   ```bash
   gh issue create --repo your-org/your-repo --title "Add feature X" --label agent
   ```

2. The orchestrator picks it up on the next tick (default: 30 seconds), clones the repo, runs the agent, and pushes a branch.

3. Close the issue to stop the agent.

For Jira, create or move an issue into the configured `pending` status. Jira
issue keys use native Jira format, for example `PROJ-42`.

## Migration Notes

- Move old top-level `repos` entries under `code_host.repos`; top-level `repos`
  is rejected by the config parser.
- Move per-repo `.agents/workflow.yaml` content into the local
  `./workflow.yaml`; target repos are no longer queried for workflow files.
- Restart the orchestrator after changing `config.yaml` or `workflow.yaml`.

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
- Claude Code (logged in with active subscription)
- `GITHUB_TOKEN` when either the tracker or code host is GitHub
- `GITLAB_TOKEN` when the code host is GitLab
- `JIRA_EMAIL` and `JIRA_API_TOKEN` when the tracker is Jira
