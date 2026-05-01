# Context

Glossary of terms used by domain experts working on local-agents. Implementation details belong in `docs/`, not here.

## Terms

### Step

A unit of work inside a workflow run. Steps run in order. A step is one of:

- **Action step** — runs a prompt, may modify the workspace, produces no structured output.
- **Output step** — an action step that additionally declares an `output_schema` (raw JSON Schema). The Claude Agent SDK enforces the schema via `outputFormat: { type: "json_schema", schema }`, re-prompting the agent internally on mismatch. On exhaustion the SDK emits a `result` message with `subtype: "error_max_structured_output_retries"` and the orchestrator aborts the run. On success the validated value arrives as `result.structured_output`, is stored under the step's name on `RunContext.outputs`, persisted to `run_step_outputs`, and addressable by later steps as `{{ steps.<name>.output.<field> }}`.

A workflow can mix both kinds. There is no separate "review" or "implement" kind — a review step is just an action step whose prompt asks the agent to inspect the diff and apply fixes directly.

Outputs are pure data. They flow into later step prompts and into `change_request` templates. They never trigger the orchestrator to do something it wouldn't otherwise do, never reorder lifecycle pins, and never gate the run.

### Branch

First-class workflow-level field. Either a static template that interpolates `{{ issue.* }}`, or a dedicated branch-naming agent that proposes a name from the issue. In both forms, branch creation runs at clone-time, before any step.

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
```

The dynamic form is for workflows that want a model-derived slug (e.g. `feat/AINENG-2310-state-clear-command`) rather than a mechanical template. It costs one extra agent call at clone-time. The SDK enforces the schema and re-prompts internally; on exhaustion the orchestrator aborts the run before any step fires.

Branch is the only field whose action timing is structurally constrained (must exist before steps that write commits) — it gets its own first-class mechanism to avoid coupling that timing to step output flow. See ADR-0001.

### Change request

The platform-neutral term for a GitHub PR or GitLab MR. Already used in `code-hosts/types.ts`.

The workflow configures two required fields under `change_request`, each a template that can interpolate `{{ issue.* }}`, `{{ attempt }}`, `{{ branch }}`, and `{{ steps.<name>.output.<field> }}`:

- `change_request.title`
- `change_request.body`

Both are required; missing fields fail at workflow parse. No silent defaults. `labels`, `draft`, reviewers, assignees, and milestones are out of scope for V1; CODEOWNERS handles reviewer assignment on the platform side.

`change_request` renders at end of run, after the last step. Because all step outputs exist by then, referencing outputs in these templates is just substitution from a fully-populated map — no timing inference involved.

### Setup

Repo-owned, not workflow-owned. The orchestrator looks for `.agent/setup.sh` in the cloned target repo and runs it once after clone, before any step. If the file is absent, no setup runs.

This keeps workflow files repo-agnostic: the same workflow drives runs across many repos with different package managers and bootstrap requirements. Repo authors define their own bootstrap once, in their repo, and every workflow targeting that repo benefits.

**Contract.** `.agent/setup.sh`:

- Runs as `bash .agent/setup.sh` with the cloned repo as `cwd`.
- Runs after `branch:` is created, so `git status` already shows the agent's branch.
- Non-zero exit aborts the run before any step fires. The agent never sees a half-bootstrapped workspace.
- stdout and stderr are captured to the canonical log alongside step output.
- Should be idempotent — retries that reuse the workspace skip setup, but a fresh clone re-runs it.
- Receives no tracker tokens, code-host credentials, or model API keys. If the script needs network access (e.g. private package registries), the credentials live in the orchestrator's repo registry and are passed as scoped env vars — not as ambient secrets.

**Out of scope for `.agent/`.** Tracker selection, code-host selection, base-branch override, and model selection are per-repo concerns but live in the orchestrator's repo registry, not in the cloned tree. The `.agent/` directory is only for things the agent's runtime in the cloned workspace needs to know.

`AGENTS.md` and `CLAUDE.md` keep their existing repo-root locations — they're prompt context, not orchestrator config.

### Commit ownership

The agent commits inside its step via `git commit` Bash calls. The orchestrator does not author commits; it only pushes the branch and opens the change request at end of run.

### Lifecycle pins

The orchestrator's actions fire at fixed points, in order:

1. Clone repo into workspace.
2. Resolve `branch:` template. Create branch.
3. Run `.agent/setup.sh` from the target repo if present.
4. Run steps in declared order. Each step has full Bash access in the workspace.
5. Push branch.
6. Render `change_request.*` templates. Open the change request.
7. Transition tracker to `awaiting_review`.

Step 6 sees all step outputs in scope; earlier pins don't. Any reference to `{{ steps.X.output.Y }}` from `change_request` is resolved at lifecycle pin 6 against the in-memory output map.

### Output persistence

Validated step outputs are persisted to the `run_step_outputs(run_id, step_name, output_json, created_at)` table when an output step succeeds, and held in-memory on `RunContext.outputs` for the lifetime of the run. They are also appended to the canonical log as observability events.

When a retry skips a previously-completed step, the lifecycle hydrates `RunContext.outputs` from `run_step_outputs` for the parent run before invoking the step runner, so downstream step prompts and the change-request renderer can resolve references to skipped steps. The agent does not get a second chance to re-decide — re-deciding would silently invalidate downstream artefacts.

### Static reference validation

At workflow parse time, every `{{ steps.X.output.Y }}` reference (in step prompts and in `change_request` templates) is checked against:

- A step named `X` must exist in `steps[]`.
- For step prompts: step `X` must appear *earlier* than the referencing step (no forward references).
- The dotted path after `output.` must resolve through step `X`'s `output_schema` (the validator walks `properties` and `items` so nested paths like `output.summary.title` are checked).

Bad references fail at workflow load, not 20 minutes into a run.
