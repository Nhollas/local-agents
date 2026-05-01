# Design: Workflow Restructure (Steps, Outputs, Branch Agent, Repo Setup)

This document is the implementation-facing design for the workflow API restructure: renaming phases to steps, adding typed step outputs, lifting branch creation into a first-class field with optional dynamic naming, replacing workflow-level `hooks:` with target-repo `.agent/setup.sh`, and adding a templated `change_request:` block.

The originating decisions are captured in [CONTEXT.md](../CONTEXT.md) and [adr/0001-phase-outputs-and-fixed-lifecycle.md](./adr/0001-phase-outputs-and-fixed-lifecycle.md). If there is a conflict, the ADR explains the rationale, but this file should describe the design to implement.

The companion examples are [examples/static-branch.yaml](../examples/static-branch.yaml) and [examples/dynamic-branch.yaml](../examples/dynamic-branch.yaml).

The execution plan and slice ledger live in [workflow-restructure-implementation-plan.md](./workflow-restructure-implementation-plan.md). This file describes *what* to build; the plan tracks *how* to slice and verify the work.

## Motivation

The current orchestrator runs multi-phase workflows where phases share a `prompt:` and optional shell expansion, but phase output is purely the agent's session state — there is no typed value that the next phase or the change-request template can read. Bootstrapping is wedged into a workflow-level `hooks:` block that bakes one repo's package manager into every workflow file, fighting the goal of one workflow driving runs across many repos. Branch naming is a bare template even when the right name needs the issue body, not just its number. And the change request gets opened with a hard-coded title/body shape that workflow authors cannot influence.

The settled design replaces those four things at once because they share the same root cause: the workflow shape conflates "what the agent does" with "how the orchestrator runs the lifecycle". This restructure separates them:

- **Steps** replace phases, with optional `output_schema` so a step can produce typed data. The name avoids collision with the SDK concept of "agent turn".
- **Branch** becomes first-class with two forms: a static template, or a dedicated agent at clone-time.
- **Change request** becomes a required, templated block with `{{ steps.X.output.Y }}` interpolation.
- **Setup** moves out of `workflow.yaml` and into the target repo at `.agent/setup.sh`, so one workflow drives runs across heterogeneous repos.
- **Lifecycle pins** stay orchestrator-owned at fixed timings; step outputs flow as data only.

## Key Decisions

| Topic | Decision |
|---|---|
| Workflow location | Unchanged. One global `./workflow.yaml` in this application repo. |
| Phase terminology | Rename `phases` → `steps`. Each step is one agent invocation. Avoids confusion with the SDK concept of an agent turn. |
| Single-prompt form | Remove. All workflows are a `steps:` array. A single-step array is the smallest valid workflow. |
| Step outputs | Optional `output_schema` per step. Validated values are addressable as `{{ steps.<name>.output.<field> }}` in later step prompts and in `change_request` templates. |
| Output gating | Outputs never gate the run. Step-level *errors* abort the run; step-level *values* do not. |
| Schema validation retries | The Claude Agent SDK enforces the schema and re-prompts internally. On exhaustion the SDK emits a `result` message with `subtype: "error_max_structured_output_retries"`; the orchestrator surfaces this as `step.failed` and aborts the run. Retry count is not configurable in the public SDK API. |
| Branch field | First-class. Static template, or dedicated branch-naming agent with `prompt:` and `schema:`. Both forms run at clone-time, before setup. |
| Change request | Required block with `title` and `body` only. Both are templates and both are required at parse time. Rendered at end of run. `labels` and `draft` are out of scope for V1. |
| Setup location | Repo-owned at `.agent/setup.sh` in the cloned target repo. Workflow-level `hooks:` block is removed. |
| Lifecycle pins | Fixed sequence: clone → branch → setup → steps → push → change request → tracker. |
| Output persistence | New `run_step_outputs(run_id, step_name, output_json, created_at)` table. Written when a step's `outputFormat` returns a validated value. Loaded into `RunContext.outputs` on retry so previously-completed steps are skipped and their outputs reused. Also appended to the canonical log as observability events. |
| Retry on resume | A retry skips previously-completed steps and reuses their stored outputs from `run_step_outputs`. The agent does not re-decide. |
| Static reference validation | Every `{{ steps.X.output.Y }}` reference is validated at workflow parse — bad references fail at load, not 20 minutes into a run. |
| Commit ownership | Unchanged. The agent commits inside its step. The orchestrator pushes and opens the change request. |

## Configuration Model

`config.yaml` is **unchanged** by this restructure. `tracker`, `code_host`, and `defaults` keep their current shapes.

## Global Workflow

The new `workflow.yaml` shape:

```yaml
branch: "agent/issue-{{ issue.number }}"        # static
# OR
branch:
  prompt: |
    Propose a branch name for {{ issue.key }}: {{ issue.title }}.
  schema:
    type: object
    properties:
      name: { type: string, pattern: "^(feat|fix|chore)/" }
    required: [name]

base_branch: main

steps:
  - name: implement
    prompt: |
      Work on {{ issue.key }}: {{ issue.title }}.
      !`git log --oneline -5`

  - name: summarise
    prompt: |
      Summarise the change for reviewers.
      !`git diff main...HEAD`
    output_schema:
      type: object
      properties:
        title: { type: string }
        body: { type: string }
      required: [title, body]

change_request:
  title: "{{ steps.summarise.output.title }}"
  body: |
    Closes {{ issue.key }}: {{ issue.title }}.

    {{ steps.summarise.output.body }}
```

The top-level `prompt:` form, the `phases:` key, and the `hooks:` block are removed. Workflows that previously used a single `prompt:` become a one-element `steps:` array. Workflows that used `hooks:` move bootstrap into the target repo's `.agent/setup.sh`.

Workflow loading remains a one-shot local file load at startup via `server/workflow/workflow-loader.ts`. Restarting the orchestrator is required to pick up workflow file changes.

## 1. Steps

### What

A step is one Claude Agent SDK `query()` invocation with a rendered prompt. Two kinds:

- **Action step** — `name`, `prompt`, optional `resume_previous`. Modifies the workspace, may commit, produces no structured output.
- **Output step** — an action step with an additional `output_schema` (raw JSON Schema). The SDK enforces the schema via `outputFormat: { type: "json_schema", schema }` and re-prompts internally on mismatch. The validated value is stored under the step's name on `RunContext.outputs` and persisted to `run_step_outputs`.

A workflow can mix both kinds. There is no separate "review" or "implement" *kind* — review is just an action step whose prompt asks the agent to inspect the diff and apply fixes directly.

### Templating

Output values are addressable in later step prompts and in `change_request` templates as `{{ steps.<name>.output.<field> }}`. Field paths may be nested (`{{ steps.summarise.output.summary.title }}`). Scalars render as-is; nested objects and arrays render as `JSON.stringify(value)`. Output references are pure substitution — they do not reorder lifecycle pins, gate the run, or trigger orchestrator side effects.

### Execution

For each step:

1. Render variables (`{{ issue.* }}`, `{{ attempt }}`, `{{ branch }}`, `{{ steps.X.output.Y }}`).
2. Expand shell blocks (`!`...``).
3. Run the agent with `query()`. If the step declares `output_schema`, pass it as `outputFormat`.
4. Consume messages. Capture `session_id` from `assistant` messages. When the SDK emits a `result` message:
   - `subtype === "success"` with `structured_output` → store under `RunContext.outputs[name]`, persist a row to `run_step_outputs`, append a canonical log event.
   - `subtype === "error_max_structured_output_retries"` → emit `step.failed`, abort the run.
5. Emit `step.started` / `step.completed` / `step.failed` markers (renamed from `phase.*`).

By default each step starts a fresh session. `resume_previous: true` carries over from the existing implementation and is unchanged.

### Retry

Retries skip previously-completed steps and reuse their stored outputs. The agent does not re-decide. This matches the existing phase-skip behaviour, just under the new name.

Persist `stepIndex` alongside the run's `sessionId` (renamed from `phaseIndex`). On retry, the lifecycle loads `run_step_outputs` for the parent run into `RunContext.outputs` before invoking the step runner so later steps and the change-request renderer can resolve references to skipped steps. For single-step workflows, `stepIndex` remains `0`.

### Implementation

| File | Role |
|---|---|
| `server/orchestrator/phase-runner.ts` → `step-runner.ts` | Rename. Add `output_schema` support: pass to SDK as `outputFormat`, branch on terminal `result` subtype, persist validated value on success, abort on `error_max_structured_output_retries`. |
| `server/orchestrator/agent-invoker.ts` | Add optional `outputFormat` to `AgentInvokeOptions`; thread through to `query()`. |
| `server/orchestrator/run-lifecycle.ts` | Update lifecycle markers (`phase.*` → `step.*`). Hold an in-memory `outputs` map on `RunContext`. On retry, hydrate the map from `run_step_outputs` before invoking the step runner. |
| `server/workflow/workflow.ts` | Replace `phases` schema with `steps`. Remove top-level `prompt:` form. Add optional `output_schema` per step. Extend `renderPrompt` to substitute `{{ steps.X.output.Y }}` (including nested paths) against an outputs map. |
| `server/workflow/workflow-loader.ts` | Static reference validation (see section 5). |
| `server/db/schema.ts` | Rename `runs.phase_index` → `runs.step_index`. Add `run_step_outputs(run_id, step_name, output_json, created_at)` with PK on `(run_id, step_name)`. Rename event-type literals (`phase.*` → `step.*`); historic rows keep their old type strings — no backfill. |

## 2. Branch

### What

Branch is a first-class workflow field with two forms.

**Static template.** Same as today — a string with `{{ issue.* }}` interpolation, rendered at clone-time.

```yaml
branch: "agent/issue-{{ issue.number }}"
```

**Dynamic agent.** A dedicated agent at clone-time that proposes the branch name from the issue. The agent receives the issue and emits a value validated against the declared `schema`.

```yaml
branch:
  prompt: |
    Propose a branch name for {{ issue.key }}: {{ issue.title }}.
  schema:
    type: object
    properties:
      name: { type: string, pattern: "^(feat|fix|chore)/[A-Z]+-[0-9]+-[a-z0-9-]+$" }
    required: [name]
```

The dynamic form costs one extra agent call at clone-time. The SDK enforces the schema and re-prompts internally; on exhaustion it emits `result` with `subtype: "error_max_structured_output_retries"` and the orchestrator aborts the run before any step fires.

### Execution

Branch creation runs at lifecycle pin 2: after clone, before setup, before any step.

For the static form, render the template and `git checkout -b` the result.

For the dynamic form:

1. Render the prompt against the issue.
2. Run a single `query()` with `outputFormat: { type: "json_schema", schema }`.
3. Branch on the terminal `result` subtype. On `success`, take `structured_output.name`. On `error_max_structured_output_retries`, abort the run.
4. `git checkout -b <validated-name>`.
5. Store the resolved name on `RunContext.branch` so later step prompts and `change_request` templates can reference `{{ branch }}`.

### Implementation

| File | Role |
|---|---|
| `server/workflow/workflow.ts` | Accept either `string` or `{ prompt, schema }` for `branch`. |
| `server/orchestrator/orchestrator.ts` | Branch resolution path (string vs object). For the agent form, invoke `agent-invoker.ts` once at clone-time with `outputFormat`. |
| `server/orchestrator/workspace.ts` | `git checkout -b <name>` after resolution. |

## 3. Change Request

### What

A required workflow-level block defining the PR/MR opened at end of run.

```yaml
change_request:
  title: "{{ steps.summarise.output.title }}"
  body: |
    Closes {{ issue.key }}: {{ issue.title }}.
    {{ steps.summarise.output.body }}
```

Both fields are required. Missing fields fail at workflow parse — no silent defaults. `labels`, `draft`, reviewers, assignees, and milestones are out of scope for V1; CODEOWNERS handles reviewer assignment on the platform side.

### Execution

`change_request` renders at lifecycle pin 6, after the last step and before the tracker transition. Because all step outputs exist by then (either freshly captured in this process or hydrated from `run_step_outputs` on retry), referencing `{{ steps.X.output.Y }}` is straightforward substitution from a fully-populated map — there is no timing inference.

The `CodeHostAdapter.createChangeRequest()` signature is unchanged.

### Implementation

| File | Role |
|---|---|
| `server/workflow/workflow.ts` | Add required `change_request` schema (`title`, `body`). |
| `server/orchestrator/change-request-renderer.ts` | New module. Renders `title` and `body` against the merged context (`issue`, `attempt`, `branch`, `steps.*.output.*`). |
| `server/orchestrator/run-lifecycle.ts` | Call `change-request-renderer` at lifecycle pin 6 and pass the rendered values to `codeHost.createChangeRequest`. |

## 4. Repo Setup

### What

Repo-specific bootstrap (`pnpm install`, codegen, etc.) lives in the target repo, not the workflow. The orchestrator runs `.agent/setup.sh` from the cloned repo if it exists. If absent, no setup runs.

This keeps `workflow.yaml` repo-agnostic. The same workflow drives runs across many repos with different package managers and bootstrap requirements.

### Contract

`.agent/setup.sh`:

- Executes as `bash .agent/setup.sh` with the cloned repo as `cwd`.
- Runs at lifecycle pin 3, after the branch is created. `git status` shows the agent's branch.
- Non-zero exit aborts the run before any step fires.
- stdout and stderr are captured to the canonical log.
- Should be idempotent. Retries that reuse the workspace skip setup; a fresh clone re-runs it.
- Receives no tracker tokens, code-host credentials, or model API keys.

### What is removed

The workflow-level `hooks: { after_create, before_run, after_run }` block is removed. Migration:

- `after_create` content moves to `.agent/setup.sh` in each target repo.
- `before_run` and `after_run` content has no replacement. If a workflow author needs pre-step or post-step behaviour, they express it as a shell block (`` !`...` ``) in the relevant step's prompt.

### Implementation

| File | Role |
|---|---|
| `server/orchestrator/workspace.ts` | After branch creation, check for `.agent/setup.sh`. If present, execute with bash, fail-fast on non-zero exit. |
| `server/orchestrator/run-lifecycle.ts` | Insert setup at lifecycle pin 3 between branch creation and the first step. Remove the legacy hooks invocations. |
| `server/workflow/workflow.ts` | Remove `hooks` from the workflow schema. |

## 5. Static Reference Validation

### What

At workflow parse time, every `{{ steps.X.output.Y }}` reference (in step prompts and in `change_request` templates) is validated:

- A step named `X` must exist in `steps[]`.
- For step prompts: step `X` must appear *earlier* than the referencing step (no forward references).
- The dotted path after `output.` must resolve through step `X`'s `output_schema`. Validation walks the schema's `properties` tree (and `items` for arrays), so `{{ steps.summarise.output.summary.title }}` is checked against `properties.summary.properties.title`.

Bad references fail at workflow load, not 20 minutes into a run.

`change_request` references are not subject to the forward-reference rule because all steps have completed by the time `change_request` renders.

### Execution

Run after schema validation succeeds, before `loadWorkflow()` returns. Errors include the file path, the offending reference, and the reason (unknown step, forward reference, unknown field).

### Implementation

| File | Role |
|---|---|
| `server/workflow/workflow-loader.ts` | After schema parse, walk every prompt string and `change_request` template, extract `{{ steps.X.output.Y... }}` references, walk the referenced step's `output_schema` to confirm the dotted path resolves. |

## Implementation Order

Implement foundation refactors first, then features. This minimises churn — the rename and removals settle the surface before new functionality is added.

1. **Foundation PR** — rename `phases` → `steps` across `server/`, `dashboard/`, `db/schema.ts`, and tests; rename `runs.phase_index` → `runs.step_index`; remove top-level `prompt:` form; remove `hooks:` block and add `.agent/setup.sh` invocation at lifecycle pin 3; add `run_step_outputs` table. No new behaviour, no backfill of historic event-type rows.
2. **Change request block** — add required `change_request: { title, body }` schema, the `change-request-renderer.ts` module, and lifecycle pin 6 wiring. Templating supports `{{ issue.* }}`, `{{ attempt }}`, `{{ branch }}` only at this point — output substitution lands in step 4.
3. **Output steps** — extend `AgentInvokeOptions` with `outputFormat`; teach `step-runner.ts` to consume the terminal `result` message, persist on success, abort on `error_max_structured_output_retries`; hydrate `RunContext.outputs` from `run_step_outputs` on retry.
4. **Output substitution** — extend `renderPrompt` to handle `{{ steps.X.output.Y... }}` (including nested paths) against the outputs map. Wire it into both step prompts and the change-request renderer.
5. **Dynamic branch agent** — branch field accepts string or `{ prompt, schema }`; agent form invokes the same SDK path as output steps.
6. **Static reference validation** — walk prompts and change-request templates after schema parse; validate dotted paths against the relevant step's `output_schema`.

## Deferred Items

These are intentionally out of scope until a real consumer need appears:

- alternative agent runtimes (codex, aider, etc.) — Claude Agent SDK only for V1
- alternative sandboxes — current workspace model only
- per-step wall-clock timeout override
- output gating (a step declaring its output blocks the run if invalid)
- per-repo workflow override
- workflow file watch or reload without restart
- a `completion_signal` sentinel (Sandcastle-style early exit)
- branch-name conflict resolution when the agent proposes an already-existing branch
- `change_request` updates on retry vs always opening fresh
- `change_request.labels` and `change_request.draft` (hardcoded in the code-host adapter for V1)
- per-invocation tool scoping for the branch agent (currently inherits the step agent's tool set)
