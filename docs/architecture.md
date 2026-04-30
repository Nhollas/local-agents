# Architecture

A polling orchestrator watches multiple repos for labelled issues, merges them into an oldest-first queue, creates isolated workspaces, and runs Claude agents powered by your existing Claude Code subscription.

```
Issue Tracker (GitHub Issues or Jira)
        │
        ▼
Polling Orchestrator (tick every N seconds)
        │
        ▼
Fetch All Repos → Merge → Sort oldest first
        │
        ▼
State transition → Create Workspace (git clone) → Run Agent
        │
        ▼
Claude Agent SDK (query)
        │
        ▼
Push Result (commits, branches, PRs/MRs)
```

The issue tracker is the orchestration layer. Polling means the orchestrator is resilient to downtime (it catches up on the next tick), works behind NATs and firewalls, and needs nothing exposed publicly.

## How It Works

### 1. Central Config

A `config.yaml` defines one tracker, one code host, the code-host repo list,
and operational defaults:

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

GitLab code hosting uses the same `code_host.repos` list. `base_url` is
optional and defaults to `https://gitlab.com`; it is commonly paired with Jira
tracking in the current implementation:

```yaml
code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  repos:
    - group/project
```

Jira tracking maps logical orchestrator states to Jira status names. Statuses
default to `To Do`, `In Progress`, and `In Review`; override them when your
Jira project uses different names. Because Jira issues do not identify a code
repo, Jira mode requires exactly one configured code-host repo:

```yaml
tracker:
  kind: jira
  base_url: https://yourco.atlassian.net
  project: PROJ
  statuses:
    pending: "Backlog"
    running: "Doing"
    awaiting_review: "Code Review"

code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  repos:
    - group/project
```

### 2. Global Workflow

The local-agents working directory contains one `workflow.yaml` with hooks and
the prompt. The same workflow is used for every configured repo:

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

Hooks must use plain git commands, not platform-specific CLI tools. The orchestrator handles cloning via `git clone` before the `after_create` hook runs.

Workflows define exactly one of `prompt` or `phases`. Multi-phase workflows run
ordered prompts in one dispatch. By default each phase starts a fresh Claude
session; a phase can set `resume_previous: true` to resume the previous phase's
session:

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

Shell blocks written in workflow prompts with `` !`command` `` run in the
workspace after template rendering and before the Claude Agent SDK receives the
prompt. Stdout replaces the block. Non-zero exit, timeout, signal termination,
spawn failure, or output overflow fails the run. Issue fields cannot inject
executable shell blocks because only blocks authored in the raw workflow
template are marked for execution.

### 3. The Orchestrator Loop

Each tick:

1. **Fetch** active issues from all configured repos (concurrent)
2. **Merge** all issues into a single list, sorted oldest-first for cross-repo fairness
3. **Reconcile** — if a previously running issue is no longer active, kill the run
4. **Dispatch** — for each unclaimed issue (up to `max_concurrent`), transition it to `running`, create a workspace, and start a Claude agent

### 4. Logical Tracker State

The orchestrator tracks work through logical states and lets each tracker
adapter map those states to platform-specific labels or statuses:

| Logical state | GitHub label | Default Jira status |
|---|---|---|
| `pending` | `agent` | `To Do` |
| `running` | `agent:running` | `In Progress` |
| `awaiting_review` | `agent:awaiting-review` | `In Review` |

This keeps the issue tracker as the single source of truth for what's happening
without making the orchestrator know GitHub label strings or Jira status names.

GitHub issue keys use `owner/repo#42`. Jira issue keys use native Jira format,
for example `PROJ-42`.

### 5. Workflow Loading

The orchestrator loads `./workflow.yaml` once from the local-agents working
directory at startup. Restart the orchestrator to pick up workflow changes.

### 6. Workspaces And Hooks

Each issue gets an isolated workspace directory. The orchestrator runs `git clone` to set up the workspace, then executes lifecycle hooks:

- `after_create` — runs once when workspace is first created (e.g. create a branch)
- `before_run` — runs before each agent execution (e.g. fetch latest, rebase)
- `after_run` — runs after agent completes (e.g. push the branch)

### 7. The Agent

Uses `query()` from the Claude Agent SDK with full tool access. Each prompt or
phase prompt is rendered from the workflow template with issue context injected
via `{{ variable.path }}` interpolation, then shell-expanded if it contains
trusted shell blocks.

Retries skip previously completed phases and resume from the failed phase when
the previous in-flight session ID is available.

### 8. Reconciliation

The orchestrator detects when issues are closed or resolved and kills the corresponding agent run. Only repos whose issues were successfully fetched are considered for reconciliation, so transient fetch failures do not kill active runs.

## Adapter Interfaces

The system uses two adapter interfaces to stay decoupled from any specific platform:

- **TrackerAdapter** — fetches active issues from a tracker and manages label state
- **CodeHostAdapter** — fetches files from repos, generates clone URLs, and creates pull requests or merge requests

GitHub is implemented as both a tracker and code host. Jira is implemented as a
tracker. GitLab is implemented as a code host. Adding full support for another
platform means implementing the relevant adapter interface.

## Migration Notes

- `repos` now lives under `code_host.repos`; top-level `repos` is not accepted.
- The workflow now lives at local `./workflow.yaml`; target repo
  `.agents/workflow.yaml` files are not fetched.
- Workflow changes are picked up on orchestrator restart, not by polling or hot
  reload.
- Jira mode supports one code-host repo per orchestrator instance.

## Design Principles

- **Issue tracker as orchestration** — no separate task queue or job system. The tracker is the source of truth for what work exists and what state it's in.
- **Multi-repo, single orchestrator** — one process polls all configured repos with a shared concurrency pool, keeping deployment and configuration simple.
- **Cross-repo fairness** — issues are merged into a single queue so no repo starves another.
- **Narrow scope** — each agent works on one issue at a time in an isolated workspace.
- **Codebase as context** — agents discover what they need by reading the repo, not from configuration passed to them.
- **Disposable work environments** — clone fresh, work in /tmp, clean up after.
- **Same toolchain as engineers** — agents run tests, hooks, and linters the same way you would.
- **Plain git hooks** — no platform-specific commands in repo workflows, keeping them portable across code hosts.
