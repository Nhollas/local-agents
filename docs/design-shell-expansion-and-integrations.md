# Design: Shell Expansion, Multi-Phase Workflows, GitLab & Jira

This document is the implementation-facing design for shell expansion, multi-phase workflows, GitLab code hosting, and Jira tracking.

It has been reconciled with the Q&A decisions captured in [design-shell-expansion-and-integrations-decisions.md](./design-shell-expansion-and-integrations-decisions.md). If there is a conflict, the decisions document explains the rationale, but this file should describe the design to implement.

The living execution checklist is [shell-expansion-and-integrations-implementation-plan.md](./shell-expansion-and-integrations-implementation-plan.md).

## Motivation

The current orchestrator dispatches a single Claude agent per issue with a statically-rendered prompt. That works for straightforward tasks, but it falls short when the agent needs dynamic context, when a task benefits from staged prompts, or when teams use GitLab and Jira instead of GitHub.

The settled design adds:

- pre-prompt shell expansion for dynamic context
- simple multi-phase workflows as staged prompts
- GitLab as a code host
- Jira as a tracker
- a global workflow file owned by the local-agents application

## Key Decisions

| Topic | Decision |
|---|---|
| Workflow location | One global `./workflow.yaml` in this application repo. Target repos do not carry `.agents/workflow.yaml`. |
| Workflow count | One workflow applies to every configured repo. No per-repo workflow selection for now. |
| Shell expansion | Execute trusted template-authored `` !`command` `` blocks before sending the prompt to the agent. |
| Shell failures | Non-zero exit, timeout, and spawn errors all fail the run. |
| Shell timeout | Hard-coded 30 seconds. No override syntax or config knob. |
| Multi-phase model | Phases are staged prompts. No outer completion signal or iteration loop. |
| Hooks | Hooks bracket the whole dispatch. They do not run per phase. |
| Retry | A retry resumes the failed phase using the in-flight session ID and skips completed phases. |
| Tracker states | The orchestrator uses logical states. Adapters map those states to labels or statuses. |
| Issue keys | Use platform-native keys: `owner/repo#42` for GitHub and `PROJ-42` for Jira. |
| Code host config | Use singular `code_host`, because one provider is configured at a time. Its `repos` list defines the code repos agents may work in. |
| Jira repo mapping | For Jira, enforce exactly one configured code-host repo per orchestrator instance. |

## Configuration Model

`config.yaml` owns service configuration and the code-host repo list.

The config key is singular: `code_host`, not `code_hosts`. The application configures one code host provider at a time, and `code_host.repos` is the allow-list of repositories the orchestrator may clone, work in, and open PRs/MRs against. The existing top-level `repos` field should move under `code_host` as part of this change.

```yaml
tracker:
  kind: github | jira
  # Required when kind=jira:
  base_url: https://yourco.atlassian.net
  project: PROJ
  statuses:
    pending: "To Do"
    running: "In Progress"
    awaiting_review: "In Review"

code_host:
  kind: github | gitlab
  # Optional when kind=gitlab; defaults to https://gitlab.com:
  base_url: https://gitlab.example.com
  repos:
    - owner/repo

defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  max_retries: 3
  model: claude-sonnet-4-6
  workspace_root: /tmp/local-agent-workspaces
```

Validation rules:

- `tracker.kind: github` does not accept Jira-only fields.
- `tracker.kind: jira` requires `base_url` and `project`.
- `tracker.kind: jira` requires `code_host.repos` to contain exactly one repo.
- `code_host.repos` is a plain string list. There is no object form yet.

## Global Workflow

The workflow lives at `./workflow.yaml`, relative to the orchestrator working directory.

```yaml
branch: "agent/issue-{{ issue.number }}"
base_branch: main

hooks:
  after_create: "pnpm install"
  before_run: "git config user.email bot@example.com"
  after_run: "pnpm lint:fix"

prompt: |
  Fix issue {{ issue.key }}.
  !`git log --oneline -5`
```

The workflow can use either `prompt` or `phases`, but not both.

```yaml
branch: "agent/issue-{{ issue.number }}"
base_branch: main

phases:
  - name: plan
    prompt: |
      Analyse issue {{ issue.key }} and write the plan to PLAN.md.
      !`git log --oneline -5`

  - name: implement
    resume_previous: true
    prompt: |
      Read PLAN.md and implement the plan.
      !`test -f PLAN.md`

  - name: review
    prompt: |
      Review the diff against the plan.
      !`git diff {{ workflow.base_branch }}...HEAD`
```

Workflow loading becomes a one-shot local file load at startup:

- `server/workflow/workflow-cache.ts` should be replaced or reduced to `loadWorkflow(path): RepoWorkflow`.
- Polling refresh and last-known-good workflow cache logic should be removed.
- `codeHost.fetchFile()` is no longer used to load workflows from target repos.
- Restarting the orchestrator is required to pick up workflow file changes.

## 1. Shell Expansion

### What

Prompt templates may include shell blocks using this syntax:

```markdown
## Recent commits
!`git log --oneline -10`

## Open TODOs
!`grep -rn "TODO" src/ --include="*.ts" | head -20 || true`
```

Each block is executed in the cloned workspace directory and replaced with stdout before the agent receives the prompt.

Variable substitution runs before command execution, so commands can reference issue data:

```markdown
!`git log --oneline --grep="{{ issue.key }}" -10`
```

### Security Model

Issue titles and descriptions are attacker-controlled. The expansion pipeline must prevent issue content from injecting executable shell blocks.

Pipeline:

1. Before template substitution, mark shell blocks authored in the raw workflow template by inserting a hidden marker between `!` and the backtick.
2. Run `{{ }}` substitution.
3. Execute only marked shell blocks.
4. Leave unmarked `` !`...` `` text as literal prompt text.
5. Strip the marker from variable values before substitution to prevent marker forgery.
6. Ensure no marker character reaches the final agent prompt.

The full prompt pipeline is:

```text
mark shell blocks -> render template variables -> expand marked shell blocks -> agent
```

### Execution Rules

- Commands run in the workspace directory.
- Commands run in parallel with `Promise.all`.
- Timeout is 30 seconds.
- Non-zero exit fails the run.
- Timeout fails the run.
- Spawn error fails the run.
- stderr should be included in the surfaced error when available.
- There is no sandboxing beyond the marker system.

### Implementation

| File | Role |
|---|---|
| `server/workflow/prompt-preprocessor.ts` | New shell block marker and expansion helpers. |
| `server/workflow/workflow.ts` | Integrate marking into workflow prompt parsing/rendering as needed. |
| `server/orchestrator/orchestrator.ts` | Expand shell blocks after prompt rendering and before `query()`. |

## 2. Multi-Phase Workflows

### What

Multi-phase workflows are ordered prompts within one dispatch. Each phase runs one Claude Agent SDK `query()` call and lets the agent run to natural completion.

The schema intentionally stays simple:

```typescript
type WorkflowPhase = {
  name: string;
  prompt: string;
  resume_previous?: boolean;
};
```

There is no external signal matching and no orchestrator-level loop that re-invokes a phase. If a phase needs a precondition, express it as a strict shell block in the next phase.

### Execution

For each phase:

1. Render variables.
2. Expand shell blocks.
3. Run the agent with `query()`.
4. Capture the resulting session ID.
5. Emit phase boundary log markers.

By default, each phase starts a fresh session. If `resume_previous: true`, the phase resumes the previous phase's session.

### Retry

Retries resume from the failed phase:

- completed phases are skipped
- the failed phase is retried
- the failed phase's in-flight session ID is resumed when available
- workspace and branch state carry through retries

Persist `phaseIndex` alongside the run's existing `sessionId`. For single-prompt workflows, `phaseIndex` remains `0`.

### Hooks

Hooks bracket the whole dispatch:

- `after_create` runs when the workspace is created
- `before_run` runs once before the first phase or single prompt
- `after_run` runs once after the final phase or single prompt succeeds

Per-phase setup should be expressed with shell blocks in phase prompts.

### Observability

Use one run row per dispatch. Phases are sub-units of that dispatch, not separate runs.

Schema addition:

```typescript
runs.phaseIndex: integer("phase_index").default(0)
```

Canonical log markers:

- `phase.started` with `{ name, index, total }`
- `phase.completed` with `{ name, index, durationMs }`
- `phase.failed` with `{ name, index, error }`

Retry chains continue to use `parentRunId`.

## 3. GitLab Code Host Integration

### What

Add a `CodeHostAdapter` implementation for GitLab, backed by a thin REST client.

### Adapter Mapping

| CodeHostAdapter method | GitLab implementation |
|---|---|
| `fetchFile(repo, path, ref)` | `GET /api/v4/projects/:id/repository/files/:path?ref=:ref` |
| `cloneUrl(repo)` | `https://{base_url}/{repo}.git` |
| `createChangeRequest(repo, head, base, title, body)` | List MRs with `source_branch=head`; return existing or create one. |

The `repo` parameter is the GitLab project path, for example `group/subgroup/project`. URL-encode it as the GitLab project ID.

### Config

```yaml
code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  repos:
    - myorg/payments-api
```

`base_url` defaults to `https://gitlab.com`.

### Authentication

Use:

```text
PRIVATE-TOKEN: <GITLAB_TOKEN>
```

`GITLAB_TOKEN` is required at startup when `code_host.kind` is `gitlab`.

### Implementation

| File | Role |
|---|---|
| `server/gitlab-client.ts` | Typed REST client for GitLab API v4. |
| `server/code-hosts/gitlab.ts` | GitLab `CodeHostAdapter`. |
| `server/config.ts` | Accept `code_host.kind: "gitlab"` and optional `base_url`. |
| `server/env.ts` | Validate `GITLAB_TOKEN` when GitLab is configured. |
| `server/server.ts` | Instantiate GitLab adapter when configured. |

## 4. Tracker Integration

### Tracker Adapter Shape

The orchestrator uses logical tracker states:

```typescript
type TrackerState = "pending" | "running" | "awaiting_review";
```

Adapters own all platform-specific mapping:

```typescript
type TrackerAdapter = {
  fetchIssue(repo: string, issueNumber: number): Promise<Issue>;
  fetchActiveIssues(repo: string, state: TrackerState): Promise<Issue[]>;
  transitionState(
    repo: string,
    issueNumber: number,
    from: TrackerState,
    to: TrackerState,
  ): Promise<void>;
  parseIssueKey(key: string): { repo: string; number: number };
};
```

The orchestrator should not know GitHub label names or Jira status names.

### GitHub

Move the GitHub label mapping into `server/trackers/github.ts`:

| Logical state | GitHub label |
|---|---|
| `pending` | `agent` |
| `running` | `agent:running` |
| `awaiting_review` | `agent:awaiting-review` |

GitHub issue keys remain `owner/repo#42`.

### Jira

Add a Jira Cloud tracker adapter backed by a thin REST client.

Jira maps logical states to status names:

| Logical state | Default Jira status |
|---|---|
| `pending` | `To Do` |
| `running` | `In Progress` |
| `awaiting_review` | `In Review` |

Statuses are configurable:

```yaml
tracker:
  kind: jira
  base_url: https://yourco.atlassian.net
  project: PROJ
  statuses:
    pending: "Backlog"
    running: "Doing"
    awaiting_review: "Code Review"
```

When `statuses` is omitted, use the defaults above.

Jira issue keys are native Jira keys, for example `PROJ-42`.

### Jira Adapter Mapping

| TrackerAdapter method | Jira implementation |
|---|---|
| `fetchIssue(repo, number)` | `GET /rest/api/3/issue/{project}-{number}` |
| `fetchActiveIssues(repo, state)` | JQL by configured project and mapped status, ordered by creation time. |
| `transitionState(repo, number, from, to)` | Resolve the transition whose target status matches `to`, then POST it. |
| `parseIssueKey(key)` | Parse native Jira keys such as `PROJ-42`. |

For Jira, `repo` means the global `tracker.project` value.

Because Jira issues do not identify the code repo they belong to, Jira support is limited to one configured code-host repo per orchestrator instance.

### Jira Authentication

Use Jira Cloud basic auth:

```text
Authorization: Basic <base64(JIRA_EMAIL:JIRA_API_TOKEN)>
```

`JIRA_EMAIL` and `JIRA_API_TOKEN` are required at startup when `tracker.kind` is `jira`.

### Implementation

| File | Role |
|---|---|
| `server/jira-client.ts` | Typed REST client for Jira API v3. |
| `server/trackers/jira.ts` | Jira `TrackerAdapter`. |
| `server/config.ts` | Accept `tracker.kind: "jira"`, `base_url`, `project`, and optional `statuses`. |
| `server/env.ts` | Validate `JIRA_EMAIL` and `JIRA_API_TOKEN` when Jira is configured. |
| `server/server.ts` | Instantiate Jira adapter when configured. |

## Implementation Order

Use [shell-expansion-and-integrations-implementation-plan.md](./shell-expansion-and-integrations-implementation-plan.md)
as the execution ledger. It owns slice status, dependencies, verification notes, and
the exact branch sequence.

At a high level, implement the foundation refactors first, then features:

1. Move repo configuration under `code_host.repos`.
2. Replace per-repo workflow loading with one local `./workflow.yaml`.
3. Move tracker state and issue-key parsing behind tracker adapters.
4. Add shell expansion.
5. Add multi-phase workflows.
6. Add GitLab code-host support.
7. Add Jira tracker support.
8. Refresh user-facing docs after behavior lands.

## Deferred Items

These are intentionally out of scope until a real consumer need appears:

- multi-repo Jira disambiguation
- multiple workflows or per-repo workflow overrides
- per-block shell timeout override
- configurable GitHub label strings
- workflow file watch or reload without restart
