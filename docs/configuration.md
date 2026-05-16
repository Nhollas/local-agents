# Configuration Reference

Canonical reference for the two YAML files the orchestrator reads at startup. For how the system actually runs, see [architecture.md](architecture.md).

- `config.yaml` defines the tracker, the code host, and operational defaults.
- `workflow.yaml` defines the branch, the steps the agent runs, and the change-request template.

Both files are validated by Zod schemas at startup. Unknown fields, missing fields, or type mismatches cause the orchestrator to fail before it opens any sockets.

## Sections

- [`config.yaml`](#configyaml)
- [`workflow.yaml`](#workflowyaml)
- [Template language](#template-language)
- [Shell blocks](#shell-blocks)
- [Repo-side bootstrap](#repo-side-bootstrap)

---

## `config.yaml`

```yaml
tracker:
  kind: jira
  base_url: https://yourco.atlassian.net
  project: PROJ
  trigger_label: local-agents
  statuses:
    pending: "To Do"
    running: "In Progress"
    awaiting_review: "In Review"

code_host:
  kind: github
  scopes:
    - acme

defaults:
  polling_interval_ms: 30000
  max_concurrent: 2
  workspace_root: /tmp/local-agent-workspaces

agent:
  env:
    include:
      - ANTHROPIC_API_KEY
```

### `tracker`

Jira is the supported tracker.

| Field            | Type   | Description |
|------------------|--------|-------------|
| `kind`           | string | Must be `jira`. |
| `base_url`       | URL    | Your Jira Cloud base URL, for example `https://yourco.atlassian.net`. |
| `project`        | string | Jira project key, for example `PROJ`. |
| `trigger_label`  | string | Issues without this label are ignored. Used to opt issues into the orchestrator. |
| `statuses`       | object | Maps the three logical states onto your project's Jira status names. All three are required. |

Logical states: `pending`, `running`, `awaiting_review`. The orchestrator does not assume any particular Jira status names; whatever you put on the right-hand side is what it queries for and transitions to.

### `code_host`

A discriminated union on `kind`. Configure exactly one.

#### GitHub

```yaml
code_host:
  kind: github
  scopes:
    - acme
```

| Field    | Type     | Description |
|----------|----------|-------------|
| `kind`   | string   | Must be `github`. |
| `scopes` | string[] | List of GitHub user or organisation slugs the orchestrator may clone from. |

#### GitLab

```yaml
code_host:
  kind: gitlab
  base_url: https://gitlab.example.com
  scopes:
    - widgets
```

| Field      | Type     | Description |
|------------|----------|-------------|
| `kind`     | string   | Must be `gitlab`. |
| `base_url` | URL      | GitLab base URL. Required even on `gitlab.com` so self-hosted instances are explicit. |
| `scopes`   | string[] | List of group or user paths the orchestrator may clone from. |

`scopes` controls which `repo:<scope>/<name>` labels the orchestrator will accept. A scope of `acme` matches `repo:acme/widgets`, `repo:acme/anvils`, and so on. Any label whose path does not start with one of the configured scopes is dropped with a logged reason.

### `defaults`

Operational settings shared across all runs.

| Field                  | Type    | Description |
|------------------------|---------|-------------|
| `polling_interval_ms`  | integer | How often the orchestrator ticks. |
| `max_concurrent`       | integer | Maximum number of runs in flight at once across all repos. |
| `workspace_root`       | string  | Filesystem path where per-issue workspaces are created. |
| `log_dir`              | string  | Directory for per-run agent tool-call logs (`<log_dir>/<run-id>.log`). Resolved relative to the orchestrator's working directory. Defaults to `./logs`. |

### Environment

Tokens and credentials live in `.env` and are loaded from the process environment. The orchestrator validates them on the basis of the configured `kind` values:

- `JIRA_EMAIL` and `JIRA_API_TOKEN` are required.
- `GITHUB_TOKEN` is required when `code_host.kind` is `github`.
- `GITLAB_TOKEN` is required when `code_host.kind` is `gitlab`.

### `agent`

Controls what the spawned Claude Agent SDK subprocess sees in its environment. The host orchestrator's env is **not** inherited wholesale; the agent gets a curated subset.

```yaml
agent:
  env:
    include:
      - ANTHROPIC_API_KEY
    set:
      CI: "true"
```

| Field         | Type     | Default | Description |
|---------------|----------|---------|-------------|
| `env.include` | string[] | `[]`    | Names of host env vars to copy through to the agent. Use this for secrets and project-specific vars. |
| `env.set`     | object   | `{}`    | Literal key/value pairs set in the agent's env. Overrides anything from `include` or the implicit shell basics. |

#### Always-included shell basics

These are passed through automatically and do not need to appear in `include`:

`HOME`, `PATH`, `SHELL`, `USER`, `LOGNAME`, `LANG`, `TZ`.

Without `HOME` the SDK can't read `~/.claude/` credentials and the agent fails to authenticate; without `PATH` it can't find `git`, `node`, `pnpm`, or `fnm`. The orchestrator treats them as prerequisites and always passes them through.

If you need to override one (for example, prepending to `PATH`), use `env.set`.

#### What to put in `include`

App secrets and project-specific vars the agent actually needs at runtime, for example:

- `ANTHROPIC_API_KEY` if you authenticate via API key instead of `claude login`.
- Private package registry tokens like `GITLAB_PACKAGES_TOKEN`.

Anything else in the host environment is left behind when the agent subprocess starts.

---

## `workflow.yaml`

The orchestrator loads `./workflow.yaml` once at startup. Restart the orchestrator to pick up workflow changes. The same workflow is used for every dispatched issue regardless of target repo, so repo-specific concerns belong in the repo itself.

A workflow has exactly three top-level fields:

```yaml
branch: ...           # how the run's branch is named
steps:                # ordered list of agent prompts
  - name: ...
    prompt: ...
change_request:       # title and body for the resulting PR/MR
  title: ...
  body: ...
```

### `branch`

`branch` is a first-class field because it is the one lifecycle action whose timing is structurally constrained: a branch must exist before any step writes commits. See [ADR 0001](adr/0001-phase-outputs-and-fixed-lifecycle.md) for the reasoning.

It can take one of two forms.

#### Static template

```yaml
branch: "agent/issue-{{ issue.number }}"
```

A non-empty string, with the [template language](#template-language) available.

#### Branch-naming agent

```yaml
branch:
  model: claude-haiku-4-5
  prompt: |
    Propose a branch name for issue {{ issue.key }}: {{ issue.title }}.
    Use kebab-case under a `<type>/` prefix.
  schema:
    type: object
    properties:
      name:
        type: string
        pattern: "^(feat|fix|chore|docs|refactor|test)/[A-Z]+-[0-9]+-[a-z0-9-]+$"
    required: [name]
```

| Field    | Type    | Description |
|----------|---------|-------------|
| `model`  | string  | Claude model ID used for the branch-naming agent. Required. |
| `prompt` | string  | Template rendered against `issue.*`. The branch agent runs at clone time, before any step. |
| `schema` | object  | JSON Schema the agent's structured output must satisfy. Validated by the SDK; the orchestrator reads `name` from the result. |

The resolved branch name is exposed to later prompts and to `change_request` as `{{ branch }}`.

### `steps`

A non-empty ordered array of step objects. Steps run sequentially.

```yaml
steps:
  - name: implement
    model: claude-sonnet-4-6
    prompt: |
      Work on {{ issue.key }}: {{ issue.title }}.
```

| Field             | Type     | Default | Description |
|-------------------|----------|---------|-------------|
| `name`            | string   | —       | Identifier for the step. Letters, digits, underscores. Used in output references and event logs. |
| `model`           | string   | —       | Claude model ID for this step. Required; every step picks its own model. |
| `prompt`          | string   | —       | Prompt template, rendered against the [available variables](#template-language). |
| `resume_previous` | boolean  | `false` | When `true`, resume the previous step's Claude session instead of starting fresh. |
| `output_schema`   | object   | —       | JSON Schema the step's structured output must satisfy. When set, the parsed output is stored under `steps.<name>.output`. |
| `allowed_tools`   | string[] | —       | Restrict the step to a specific set of Claude tool names (e.g. `[Read, Glob, Grep]` for a read-only summarisation step). When omitted, the step has full tool access. Must be non-empty if set. |
| `measure_diff`    | boolean  | `false` | When `true`, the orchestrator records the step's git diff shortstat (files changed, insertions, deletions) as span attributes. Useful for telemetry on which steps actually write code. |

#### Resuming a session

```yaml
steps:
  - name: plan
    prompt: |
      Analyse {{ issue.key }} and write PLAN.md.

  - name: implement
    resume_previous: true
    prompt: |
      Now implement PLAN.md.
```

`resume_previous: true` keeps the conversational context between the two steps. Without it, each step is a clean session.

#### Capturing structured output

```yaml
steps:
  - name: summarise
    prompt: |
      Summarise the changes on `{{ branch }}` for reviewers.
    output_schema:
      type: object
      properties:
        title: { type: string }
        body: { type: string }
      required: [title, body]
```

Outputs are referenced as `{{ steps.<name>.output.<path> }}`. Object values are serialised with `JSON.stringify`; scalars are inserted directly.

#### Picking a model per step

```yaml
steps:
  - name: implement
    model: claude-sonnet-4-6
    prompt: ...

  - name: review
    model: claude-opus-4-7
    prompt: ...

  - name: summarise
    model: claude-haiku-4-5
    prompt: ...
```

Every step declares its own `model`. There is no workflow-wide default, so the cost and quality trade-off for each step has to be made explicitly in the workflow file itself.

### `change_request`

```yaml
change_request:
  title: "{{ steps.summarise.output.title }}"
  body: |
    Closes {{ issue.key }}: {{ issue.title }}.

    {{ steps.summarise.output.body }}
```

| Field   | Type   | Description |
|---------|--------|-------------|
| `title` | string | Title template for the pull or merge request. |
| `body`  | string | Body template. |

Both are required. Both have the full [template language](#template-language) available, including step outputs and `{{ branch }}`.

---

## Template language

Prompts, branch templates, and the change-request template all share a small mustache-style interpolation. References take the form `{{ variable.path }}` with optional whitespace.

Available variables:

- `issue.*`: tracker fields. `key`, `number`, `title`, `description`, `labels`, `url`, `createdAt`. Arrays are joined with `, ` when interpolated.
- `branch`: the resolved working branch for this run.
- `base_branch`: the repo's default branch, supplied by the code-host adapter.
- `steps.<name>.output.<path>`: outputs produced by earlier steps that declare an `output_schema`. Object values are serialised with `JSON.stringify`; scalars are inserted directly. Nested paths drill into the JSON object.

Unknown paths render as the empty string. Templates inside step outputs are rendered as plain text rather than re-substituted, so an output value that happens to contain `{{ ... }}` will not trigger another substitution pass.

---

## Shell blocks

A prompt may include shell expansions written as `` !`command` ``. They run in the workspace after template rendering and before the prompt reaches the Claude Agent SDK. Stdout replaces the block.

```yaml
steps:
  - name: review
    prompt: |
      <diff>
      !`git diff origin/{{ base_branch }}...HEAD`
      </diff>
```

A run fails immediately if any shell block exits non-zero, times out, is killed by a signal, or fails to spawn.

Outputs above 64 KiB are spilled to `.agent/shell-outputs/<step>-<n>.txt` in the workspace and the substituted text becomes a head/tail preview around a `... [truncated N bytes; full output at <path>] ...` marker. The agent can read the spill file directly if it needs the full output.

Only blocks that exist in the raw workflow template are marked for execution. Issue fields, branch values, and step outputs interpolated through `{{ ... }}` are inert even if they contain `` !`...` `` syntax, so untrusted text cannot inject executable commands.

---

## Repo-side bootstrap

Workflow files stay repo-agnostic, so any bootstrap that depends on a repo's toolchain belongs in the repo itself. The orchestrator runs `.agent/setup.sh` from the cloned repo if one is present, after the branch is checked out and before the first step runs. A typical script installs dependencies and warms up codegen:

```bash
#!/usr/bin/env bash
set -euo pipefail
pnpm install --frozen-lockfile
pnpm codegen
```

If the script is missing, that step is skipped silently. If it exists and fails, the run fails before any step runs.

For Node.js repos, the orchestrator treats `.nvmrc` as the repo's runtime declaration. When a cloned workspace contains `.nvmrc`, local-agents activates that version with `fnm`, then uses the resulting environment for repo setup, trusted prompt shell blocks, and agent steps. Repos written in other languages keep the configured agent environment unchanged and should express their toolchain needs in their own setup script.
