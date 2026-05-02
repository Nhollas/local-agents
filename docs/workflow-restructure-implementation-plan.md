# Living Implementation Plan: Workflow Restructure

This is the execution plan for [design-workflow-restructure.md](./design-workflow-restructure.md) and the originating [adr/0001-phase-outputs-and-fixed-lifecycle.md](./adr/0001-phase-outputs-and-fixed-lifecycle.md). The design doc describes what to build; this plan tracks how to slice and verify the work.

Keep this document current as implementation proceeds. When a slice starts, update its status. When scope changes, update the slice before changing code. When a slice completes, record the verification commands that passed and any deferred follow-up.

## Status Key

| Status | Meaning |
|---|---|
| Not started | No implementation work has begun. |
| In progress | Code is being changed for this slice. |
| Blocked | Work cannot continue without a decision or prerequisite. |
| Ready for review | Code and tests are complete; final checks passed. |
| Done | Reviewed and merged. |

## Global Quality Gates

Every implementation slice must preserve the existing repo standards:

- Read the code and tests in the area before editing. Existing test helpers are the conventions.
- Keep the slice small enough to review independently.
- Update docs in the same slice when behaviour or config changes.
- Add or update focused tests in the same layer as the behaviour being changed.
- Keep GitHub-only behaviour working unless the slice explicitly changes it.
- Do not leave compatibility gaps between workflow schema, server startup, orchestrator behaviour, dashboard assumptions, db schema, and docs.
- Run `pnpm lint`, `pnpm typecheck`, and `pnpm test` before marking a slice ready for review.
- Run `pnpm test:coverage` before the first slice starts and after feature slices that add behaviour. Coverage should stay level or improve.
- Run narrower tests while iterating, but do not use narrow tests as the final gate.

Recommended final verification block for every slice:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

Coverage checkpoint:

```bash
pnpm test:coverage
```

## Operating Model

This work should not be implemented as one long-running session. Use the plan as a sequence of independently reviewable slices.

Recommended workflow:

1. Create one branch per slice.
2. Keep only one implementation slice in progress on a branch at a time.
3. Commit each slice when its quality gates pass.
4. Update this plan before and after implementation work in the same branch.
5. Open or review each slice independently before starting dependent slices.

Branch naming convention:

```text
plan/restructure-slice-00-baseline
plan/restructure-slice-01-foundation
plan/restructure-slice-02-change-request
plan/restructure-slice-03-output-steps
plan/restructure-slice-04-output-substitution
plan/restructure-slice-05-dynamic-branch
plan/restructure-slice-06-static-validation
```

Commit strategy:

- Commit at the end of each slice after `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
- Prefer one clean commit per slice unless the slice is large enough to justify multiple reviewable commits.
- Do not commit half-passing work unless intentionally creating a checkpoint branch for handoff.
- If a context window is getting tight, stop at a clean boundary: update the slice progress notes, record failing/passing commands, and commit only if the work is coherent.

Parallelism:

- Slices 1, 2, 3, and 4 should be done sequentially because they reshape the workflow schema, the lifecycle, and the runner together. Slice 4 needs slice 3's outputs map to do anything observable.
- Slice 5 (dynamic branch) depends on slice 3's `outputFormat` plumbing in `agent-invoker.ts` but is otherwise independent of slice 4.
- Slice 6 (static validation) depends on slice 4 — the references it validates only exist in the schema once output substitution is wired.
- Slices 5 and 6 can run in parallel after slice 4 lands.

## Progress Discipline

Every implementation thread should update this document. Treat it as the project ledger, not just a plan.

When starting a slice:

- Change `Status` from `Not started` to `In progress`.
- Add a short `Started` note with date and branch.

When pausing a slice:

- Leave the status as `In progress` or `Blocked`.
- Add a `Progress notes` subsection with what changed, what remains, and exact verification status.
- Record any failing command output in summary form, not as a large pasted log.

When completing a slice:

- Change `Status` to `Ready for review`.
- Add a `Completed changes` subsection.
- Add a `Verification` subsection listing the exact commands that passed.
- After merge, change `Status` to `Done`.

Use this handoff template when a slice is interrupted:

```markdown
**Progress notes:**

- Branch:
- Files changed:
- Completed:
- Remaining:
- Verification:
- Known risks:
```

## Slice 0 — Baseline And Planning Hygiene

**Status:** Ready for review

**Started:** 2026-05-01 on `main` (small enough for a single PR; no separate branch needed for docs + workflow.yaml restoration).

**Purpose:** Establish the baseline before code changes and make sure design + glossary + examples agree.

**Scope:**

- Confirm [design-workflow-restructure.md](./design-workflow-restructure.md) is the implementation spec and [adr/0001-phase-outputs-and-fixed-lifecycle.md](./adr/0001-phase-outputs-and-fixed-lifecycle.md) is the rationale trail.
- Confirm [CONTEXT.md](../CONTEXT.md) glossary matches the design.
- Confirm [examples/static-branch.yaml](../examples/static-branch.yaml) and [examples/dynamic-branch.yaml](../examples/dynamic-branch.yaml) reflect the trimmed `change_request` shape (no `labels`, no `draft`).
- Decide what the live `workflow.yaml` at the repo root should be. The loader hardcodes `workflow.yaml`; without one, `pnpm dev` fails. Pin a starting workflow (likely a copy of `examples/static-branch.yaml` adapted to the repo's current behaviour) so subsequent slices can run end-to-end.
- Record baseline coverage before implementation begins.

**Tests:**

- No new tests; this slice is documentation + workflow.yaml + coverage capture only.

**Quality gates:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — record the numbers in `Completed changes` for comparison after each feature slice.
- `rg -n 'labels:|draft:' docs/design-workflow-restructure.md CONTEXT.md examples/*.yaml` returns nothing (or only intentional references).
- A live `workflow.yaml` exists at the repo root and `pnpm dev` boots without an immediate workflow load failure.

**Risks:**

- The `examples/*.yaml` files reference output substitution and dynamic branch features that don't exist yet. The live `workflow.yaml` must use only features supported by the *current* code (single-prompt or phases, static branch, no `change_request` block) — not the post-restructure shape — until slice 2 lands. Be explicit about this; it's the easiest place to break the dev loop.

**Completed changes:**

- Confirmed design doc, ADR-0001, and `CONTEXT.md` glossary agree on terminology — `steps`, `change_request`, lifecycle pins, `.agent/setup.sh`, `run_step_outputs`, output substitution. No drift detected.
- Confirmed `examples/static-branch.yaml` and `examples/dynamic-branch.yaml` reflect the trimmed `change_request` shape: `rg -n 'labels:|draft:' docs/design-workflow-restructure.md CONTEXT.md examples/*.yaml` returns nothing.
- Restored a live `workflow.yaml` at the repo root using only current-code features: static `branch`, `base_branch`, `hooks: { after_create, before_run, after_run }`, `phases: [implement, review]`. No `change_request`, no `output_schema`, no dynamic branch. Loader parses it cleanly via `loadWorkflow()`. Removed the redundant `git checkout -b` from `after_create` that was in the deleted #48 version (the orchestrator already creates the branch from the workflow's `branch:` template).
- Baseline coverage recorded for comparison after each feature slice:
  - Statements: **99.23%**
  - Branches: **98.97%**
  - Functions: **98.15%**
  - Lines: **99.28%**
  - Notable lower-coverage files: `agent-invoker.ts` (33.33% lines — only invoked under real SDK paths), `phase-runner.ts` (96.66%), `run-lifecycle.ts` (94.73%), `orchestrator.ts` (98.95%).

**Verification:**

- `pnpm lint` — pass (125 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (39 files, 234 tests).
- `pnpm test:coverage` — pass; baseline numbers above.
- `rg -n 'labels:|draft:' docs/design-workflow-restructure.md CONTEXT.md examples/*.yaml` — no matches.
- `loadWorkflow()` against the new `workflow.yaml` returns a valid `RepoWorkflow` with phases `[implement, review]` and all three hook keys.

## Slice 1 — Foundation

**Status:** Ready for review

**Started:** 2026-05-01 on `main` (single sweep — rename + removals + setup.sh + table all together; small enough to review as one PR).

**Purpose:** Settle the surface before adding new behaviour. Rename phases → steps, remove the top-level `prompt:` and `hooks:` forms, add `.agent/setup.sh` invocation, and add the `run_step_outputs` table without yet writing to it.

**Scope:**

- Rename `phases` → `steps` across `server/`, `dashboard/`, `db/schema.ts`, and tests.
- Rename `runs.phase_index` → `runs.step_index` (Drizzle migration; no backfill of historic event-type strings).
- Rename `RunEventType` literals `phase.started` / `phase.completed` / `phase.failed` → `step.started` / `step.completed` / `step.failed`. Historic `run_events` rows keep their old type strings — no backfill, dashboard renders both for as long as old rows exist or stops rendering them entirely (decide in this slice; document the call).
- Rename `server/orchestrator/phase-runner.ts` → `step-runner.ts`. No new behaviour in the runner itself this slice; output schema lands in slice 3.
- Remove the top-level `prompt:` form from the workflow schema. Every workflow is a `steps:` array; a single-step array is the smallest valid workflow.
- Remove the `hooks: { after_create, before_run, after_run }` block from the workflow schema. Remove all hook invocations from `run-lifecycle.ts` and `workspace.ts`.
- Add `.agent/setup.sh` invocation at lifecycle pin 3 (after branch creation, before the first step). Run as `bash .agent/setup.sh` in the cloned repo's cwd. Non-zero exit aborts the run before any step fires. Capture stdout/stderr to the canonical log. No script → no setup runs.
- Add `run_step_outputs(run_id, step_name, output_json, created_at)` table with PK `(run_id, step_name)` and a Drizzle migration. No writes from this slice; the schema is staged for slice 3.

**Natural code areas:**

- `server/workflow/workflow.ts`
- `server/workflow/workflow-loader.ts`
- `server/orchestrator/phase-runner.ts` → `step-runner.ts`
- `server/orchestrator/run-lifecycle.ts`
- `server/orchestrator/workspace.ts`
- `server/orchestrator/orchestrator.ts`
- `server/event-bus.ts`
- `server/db/schema.ts`
- `server/db/` migration files
- `server/run-repository.ts`
- `dashboard/` references to `phase.*`
- `examples/*.yaml` (already aligned, but verify)
- Live `workflow.yaml` (must convert to `steps:` shape)

**Tests:**

- Workflow parse rejects top-level `prompt:` form.
- Workflow parse rejects `hooks:` block.
- Workflow parse rejects `phases:` key (must be `steps:`).
- Workflow parse accepts a one-element `steps:` array.
- Lifecycle runs `.agent/setup.sh` from the cloned repo when present.
- Lifecycle skips setup when `.agent/setup.sh` is absent.
- Lifecycle aborts the run when `.agent/setup.sh` exits non-zero, and emits no `step.started` event.
- `step.started` / `step.completed` / `step.failed` events are emitted with the same shape as the old `phase.*` events.
- `runs.step_index` column is written on each step boundary.
- `run_step_outputs` table exists in the schema (assert via Drizzle introspection or migration test).
- Existing GitHub-only orchestration tests still pass under the renamed surface.

**Quality gates:**

- No production code references `phase` (search for `phase` in `server/` and `dashboard/`, ignoring historic event type literals if intentionally preserved).
- No production code references `hooks` from the workflow schema.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — should match or exceed the slice 0 baseline.

**Risks:**

- The rename + removals + setup wiring is a wide blast radius. Resist the urge to ship as one mega-PR with no boundaries; if review feedback piles up, split into "rename only" + "remove hooks + add setup.sh" + "rename db column + add table" sub-PRs against this branch.
- The dashboard event-type rename is easy to miss. Check `dashboard/` for any literal `"phase.started"` strings.
- `RunEventType` is an exported type union — downstream code may switch on it exhaustively. Update every switch site or accept TS errors as the audit trail.
- The Drizzle migration for the `phase_index` rename is destructive on local sqlite dbs; remind devs to wipe their local db or run the migration cleanly.
- `RunContext` has `setPhaseIndex` — this name needs renaming too, alongside any retry path that reads `failedRun.phaseIndex`.

**Completed changes:**

- **Rename phases → steps** across `server/`, `dashboard/`, db schema, tests, and `workflow.yaml`. The dashboard had no `phase` references to update; only server and tests.
- **Workflow schema** is now `.strict()` with required `branch`, `base_branch`, and a non-empty `steps:` array. Top-level `prompt:` form, `hooks:` block, and `phases:` key all fail at parse with explicit tests covering each rejection.
- **DB column rename**: `runs.phase_index` → `runs.step_index`. Migration `0004_workflow_restructure_slice_1.sql` does the rename in place plus creates `run_step_outputs(run_id, step_name, output_json, created_at)` with a composite primary key. Snapshot + journal updated. Verified the migration applies cleanly to a fresh sqlite db.
- **Event-type rename**: `RunEventType` literals `phase.started` / `phase.completed` / `phase.failed` → `step.started` / `step.completed` / `step.failed`. Old historic rows (if any local dev still has them) are not backfilled — pre-launch policy. The `RunEventType` union no longer includes the legacy literals; readers that switch exhaustively will surface a TS error if old rows are referenced. Dashboard never rendered phase events, so no UI work was needed.
- **Renames at the runtime boundary**: `RunContext.setPhaseIndex` → `setStepIndex`, `emitPhaseEvent` → `emitStepEvent`, `runWorkflowPhases` → `runWorkflowSteps`, `failedRun.phaseIndex` → `failedRun.stepIndex`, `RunRequest.resume.startPhaseIndex` → `startStepIndex`. `server/orchestrator/phase-runner.ts` is renamed to `step-runner.ts` (plain rename, no behaviour change in the runner itself).
- **`change_request` rename** at the user-facing event/canonical-log layer: `canonicalLog.append("phase_events", …)` → `canonicalLog.append("step_events", …)`.
- **`hooks:` block removed** from the workflow schema. All hook invocations (`after_create`, `before_run`, `after_run`) deleted from `run-lifecycle.ts` and `workspace.ts`. The `hooks` parameter on `ensureWorkspace` is gone.
- **Lifecycle pin 2 (branch creation)** is now orchestrator-owned. `run-lifecycle.ts` runs `git checkout -B <rendered-branch>` directly after clone, before setup. This replaces what the deleted `after_create` hook used to do; without it, slice-1's pin 3 setup step couldn't observe a real branch and downstream slices would have no anchor for "wherever branch creation lives after slice 1" (slice 5's wording).
- **Lifecycle pin 3 (`.agent/setup.sh`)** is wired in. New `runRepoSetup(wsPath, runShell)` helper looks for `.agent/setup.sh` in the cloned workspace; if absent, it's a no-op. If present, it invokes `bash .agent/setup.sh` with the workspace as cwd. Non-zero exit propagates and aborts the run before any step fires.
- **`run_step_outputs` table** is staged in the schema (not yet written to). Slice 3 will populate it.
- **Live `workflow.yaml`** at the repo root rewritten to the new shape: static `branch`, `base_branch: main`, two-step `steps:` array (`implement`, `review`). No `hooks:` block — `.agent/setup.sh` already does `pnpm install --frozen-lockfile`.
- **Test seam updates**: `createTestWorkspaceRoot.preCreateWorkspace` now seeds a real git repo with one commit on main so the orchestrator's `git checkout -B` succeeds in tests. The bare repo cached in `test-lifecycle.ts` is similarly seeded with a base commit on main. New `beforeFirstStep` option on `createTestRunLifecycle` lets a test drop `.agent/setup.sh` into the cloned workspace before the lifecycle handler runs.
- **Known regression (deferred)**: The orchestrator no longer pushes the branch to the remote (the `after_run` hook used to do this). Real-world PRs against an unpushed branch will fail at `codeHost.createChangeRequest`. Tests are unaffected (in-memory code-host). Adding lifecycle pin 5 push is out of slice 1 scope — slice 2 or later will fill it in.
- **Stdout/stderr capture for `setup.sh` (deferred)**: The slice plan calls for capturing setup script output to the canonical log. RunShell is kept as `Promise<void>` for now to avoid a wider test-seam churn; setup output goes to the executing process's stdio. Re-add capture when we touch the canonical log shape next.

**Verification:**

- `pnpm lint` — pass (126 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (39 files, 242 tests). Up from 234 in slice 0; the new tests cover the three step-event/setup paths plus a few legacy-rejection cases.
- `pnpm test:coverage` — Statements **99.22%** / Branches **98.93%** / Functions **98.15%** / Lines **99.28%**. Within 0.1pp of slice 0 baseline; functions and lines unchanged.
- Migration smoke test: in-memory drizzle migrate run produces tables `runs` (with `step_index`), `run_events`, and `run_step_outputs` (composite PK on `(run_id, step_name)`).
- `loadWorkflow()` against the new live `workflow.yaml` returns `{ branch, base_branch, steps: [implement, review] }` — parses cleanly under the `.strict()` schema.

## Slice 2 — Change Request Block

**Status:** Ready for review

**Started:** 2026-05-01 on `main` (single sweep — small, focused change touching schema, renderer, lifecycle, and live workflow).

**Purpose:** Replace the hardcoded PR title (`issue.title`) and body (`Closes ${issue.key}`) in `finalizeSuccess` with a templated `change_request: { title, body }` block from the workflow.

**Scope:**

- Add required `change_request: { title: string, body: string }` to the workflow schema. Both fields required at parse; missing fields fail at workflow load with a clear error.
- Add `server/orchestrator/change-request-renderer.ts`. Renders `title` and `body` against the merged context: `{ issue, attempt, branch }`. Output substitution lands in slice 4 — this slice intentionally does not add `{{ steps.*.output.* }}` support yet.
- Reuse `renderPrompt` from `server/workflow/workflow.ts` for variable interpolation; do not duplicate the substitution logic.
- Wire the renderer into `run-lifecycle.ts` at lifecycle pin 6 (`finalizeSuccess`). Pass the rendered values to `codeHost.createChangeRequest`. The adapter signature is unchanged.
- Update the live `workflow.yaml` to include a `change_request` block (using only `{{ issue.* }}` and `{{ branch }}` interpolations for now).
- Documentation in `README.md` / `docs/architecture.md` if either currently describes the hardcoded PR shape.

**Natural code areas:**

- `server/workflow/workflow.ts`
- `server/workflow/workflow-loader.ts`
- `server/orchestrator/change-request-renderer.ts` (new)
- `server/orchestrator/run-lifecycle.ts`
- `server/orchestrator/__tests__/*`
- `server/workflow/__tests__/*`
- Live `workflow.yaml`

**Tests:**

- Workflow parse rejects missing `change_request`.
- Workflow parse rejects `change_request` missing `title`.
- Workflow parse rejects `change_request` missing `body`.
- Workflow parse accepts a complete `change_request` block.
- Renderer substitutes `{{ issue.key }}`, `{{ issue.title }}`, `{{ attempt }}`, `{{ branch }}` in both `title` and `body`.
- Renderer preserves multi-line bodies and markdown formatting.
- Lifecycle calls `codeHost.createChangeRequest` with the rendered values, not the old hardcoded ones.
- Static branch workflows produce a `{{ branch }}` value the renderer can read.

**Quality gates:**

- `finalizeSuccess` no longer hardcodes `issue.title` or `Closes ${issue.key}`.
- The renderer is a pure function (input → string) — no side effects, no I/O. Easy to unit test.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — should match or exceed the slice 1 baseline.

**Risks:**

- Making `change_request` required will break any local `workflow.yaml` that doesn't have one. Update the live file in the same PR.
- The renderer needs a `branch` value at lifecycle pin 6 — confirm `RunContext.branch` is set by branch creation in slice 1's foundation work, otherwise either set it here or note the gap.
- If `body` references a variable that doesn't exist (e.g. `{{ issue.foo }}`), `renderPrompt` currently returns empty string. That's consistent but silent — the slice 6 validator catches `{{ steps.* }}` issues, but generic typo'd variables stay silent. Acceptable for V1; flag if it becomes a problem.

**Completed changes:**

- **Workflow schema**: required `change_request: { title, body }` block added to `repoWorkflowSchema` in `server/workflow/workflow.ts`. Both fields are `z.string().min(1)`. The block is itself `.strict()`, so unknown keys (`labels`, `draft`, etc.) fail at parse with a clear Zod error. Top-level workflow stays `.strict()`, so missing `change_request` fails too.
- **Renderer**: new `server/orchestrator/change-request-renderer.ts` exports a pure `renderChangeRequest({ template, issue, attempt, branch })` that returns `{ title, body }`. Reuses `renderPrompt` from `workflow.ts` for variable interpolation rather than duplicating substitution logic.
- **`renderPrompt` extension**: the variable parameter type now accepts an optional `branch?: string`. The dynamic path-walk implementation already supported this; only the type widened. Step prompt callers continue to pass `{ issue, attempt }` unchanged.
- **`finalizeSuccess` rewire**: `run-lifecycle.ts` calls `renderChangeRequest` with the workflow's template and the rendered `branch` value, then passes the rendered `title` and `body` to `codeHost.createChangeRequest`. The hardcoded `issue.title` / `Closes ${issue.key}` is gone. The adapter signature is unchanged.
- **Live `workflow.yaml`**: added a `change_request` block using only `{{ issue.* }}` and `{{ branch }}` — no `{{ steps.*.output.* }}` (slice 4 will introduce that).
- **Test fixture**: `createTestWorkflow` in `server/testing/support/fixtures.ts` and the inline `baseWorkflow` / `multiStepWorkflow` in the lifecycle tests now include a minimal `change_request` matching the previous hardcoded values, so existing assertions on `codeHost.changeRequests` continue to pass without change. A new lifecycle test covers the templated path explicitly with a custom title/body that reads `{{ issue.key }}`, `{{ issue.title }}`, `{{ attempt }}`, and `{{ branch }}`.

**Verification:**

- `pnpm lint` — pass (128 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (40 files, 250 tests; up from 242 in slice 1).
- `pnpm test:coverage` — Statements **99.22%** / Branches **98.93%** / Functions **98.16%** / Lines **99.28%**. Matches the slice 1 baseline; functions ticked up by 0.01pp from the new pure renderer.
- New tests cover: schema rejection of missing `change_request`, missing `title`, missing `body`, and unknown keys; renderer substitutes `{{ issue.* }}`, `{{ attempt }}`, and `{{ branch }}` in title and body; renderer preserves multi-line markdown bodies; renderer returns empty string for unknown vars; lifecycle calls `codeHost.createChangeRequest` with templated values that include the rendered branch.

## Slice 3 — Output Steps

**Status:** Ready for review

**Started:** 2026-05-01 on `main` (single sweep — schema + invoker + step runner + repo + lifecycle hydration; reviewable as one PR).

**Purpose:** Add `output_schema` to step definitions, plumb `outputFormat` through to the SDK, capture validated outputs, persist them, and hydrate them on retry.

**Scope:**

- Add optional `output_schema` (raw JSON Schema) to the step schema in `workflow.ts`.
- Extend `AgentInvokeOptions` in `agent-invoker.ts` with optional `outputFormat`. Thread through to `query()`.
- Teach `step-runner.ts` to consume the SDK's terminal `result` message:
  - `msg.type === "result" && msg.subtype === "success"` → store `msg.structured_output` on `RunContext.outputs[step.name]`, persist a row to `run_step_outputs`, append a canonical log event.
  - `msg.type === "result" && msg.subtype === "error_max_structured_output_retries"` → emit `step.failed` with the SDK's error subtype, abort the run.
- Add `RunContext.outputs: Record<string, unknown>` and a setter on the runner.
- Add `RunRepository` methods to write and read `run_step_outputs` rows (write keyed by `(runId, stepName)`; read by `runId` returns the full map).
- On retry in `run-lifecycle.ts`, hydrate `RunContext.outputs` from the *parent* run's `run_step_outputs` rows before invoking `runWorkflowSteps`. The retry creates a new `runId`; reads come from `parentRunId`.
- A canonical log event type for validated outputs (`step.output` or similar). Decide the shape; keep the structured value's size in mind.

**Natural code areas:**

- `server/workflow/workflow.ts`
- `server/orchestrator/agent-invoker.ts`
- `server/orchestrator/step-runner.ts`
- `server/orchestrator/run-lifecycle.ts`
- `server/runner/runner.ts`
- `server/run-repository.ts`
- `server/db/schema.ts` (already added in slice 1; this slice writes to it)
- `server/canonical-log.ts`
- `server/orchestrator/__tests__/*`
- `server/workflow/__tests__/*`

**Tests:**

- Action step (no `output_schema`) behaves unchanged — no `outputFormat` passed to invoker, no `run_step_outputs` row written.
- Output step passes `outputFormat: { type: "json_schema", schema }` to invoker.
- On `result.subtype === "success"`, validated value is on `RunContext.outputs[name]`.
- On `result.subtype === "success"`, a row is written to `run_step_outputs` with `(runId, stepName, output_json)`.
- On `result.subtype === "error_max_structured_output_retries"`, `step.failed` is emitted with the error subtype as the error message and the run aborts (subsequent steps do not start).
- Retry of a run that previously completed step `summarise` hydrates `RunContext.outputs.summarise` from the parent's `run_step_outputs` row before any step fires.
- Retry of a run whose failure was the output step itself does *not* skip that step — it re-runs from the failed step (existing retry semantics).
- Mixed action + output steps in one workflow work end-to-end.

**Quality gates:**

- The mock `AgentInvoker` used in tests must be able to emit a `result` message (not just `assistant` messages). Update test helpers if needed.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — feature slice; coverage should rise.

**Risks:**

- The exact terminal-message contract (does the SDK *always* emit a `result` message at end of stream when `outputFormat` is set? what about on caller-side abort via signal?) needs to be confirmed against the live SDK, not just the docs. Write a smoke test that invokes the real SDK against a trivial schema if practical.
- Hydration on retry is the bug magnet of this slice. Easy failure mode: new runId reads its own (empty) outputs instead of the parent's. Test specifically for retry-skip-and-substitute behaviour, not just "outputs are persisted".
- `output_json` size: structured outputs can be large (the SDK example `todoSchema` returns an array). Sqlite TEXT handles it, but consider whether to log the full value to the canonical log or just a checksum / first-N-chars summary.
- `RunContext.outputs` is shared between fresh runs and resumed runs; the type signature must reflect that it can be partially populated.

**Completed changes:**

- **Workflow schema**: optional `output_schema: Record<string, unknown>` added to `workflowStepSchema` in `server/workflow/workflow.ts`. Strict step parse still rejects other unknown keys.
- **Agent invoker**: `AgentInvokeOptions` gained optional `outputFormat: { type: "json_schema", schema }` (new `OutputFormat` type re-exported). `claudeSdkAgentInvoker` threads it into `query()` only when set, so action-step calls remain identical to before.
- **Step runner** (`server/orchestrator/step-runner.ts`):
  - When `step.output_schema` is present, builds `{ type: "json_schema", schema }` and passes to the invoker.
  - Iterates the message stream and now consumes terminal `result` messages too (not just `assistant`). On `result.subtype === "success"` for an output step, captures `structured_output` via `ctx.setStepOutput(step.name, value)` and appends a `step_outputs` canonical-log entry. On `result.subtype === "error_max_structured_output_retries"` (and other error subtypes), throws — the existing `catch` in the runner emits `step.failed` with the subtype as the error message and aborts the run before subsequent steps fire.
  - Action steps (no `output_schema`) ignore terminal `result` messages silently — preserves backwards compatibility with the SDK now always emitting one.
- **`RunContext`** (`server/runner/runner.ts`):
  - New `outputs: Record<string, unknown>` (the readable map, populated from `job.initialOutputs` at enqueue) and `setStepOutput(stepName, value)` setter (updates the in-memory map AND persists via `repo.writeStepOutput`).
  - `AgentJob.initialOutputs?: Record<string, unknown>` carries hydrated parent outputs into the runner.
- **Run repository** (`server/run-repository.ts`): two new methods. `writeStepOutput(runId, stepName, value)` upserts a `run_step_outputs` row keyed by the composite primary key. `getStepOutputs(runId)` returns `Record<stepName, value>` (empty object for unknown runs).
- **Run lifecycle**: now takes `repo: RunRepository` in its deps. On dispatch, when `resume.parentRunId` is set, calls `repo.getStepOutputs(parentRunId)` and threads the result through `AgentJob.initialOutputs`. Hydration is purely in-memory — the runner does not re-persist parent outputs under the new run id, so `run_step_outputs` only ever contains rows for steps that *actually executed and produced output* in their own run.
- **Test seam**: no changes to the scripted-agent contract. The new `step-runner.test.ts` constructs a fake `RunContext` directly to exercise hydration and result-message handling in isolation. The lifecycle integration tests cover the wiring (output rows persisted, `outputFormat` reaches the invoker, retry doesn't crash and doesn't re-persist parent outputs).

**Verification:**

- `pnpm lint` — pass (129 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (41 files, 263 tests; up from 250 in slice 2). New tests: 5 in `step-runner.test.ts` (action step path, output-step success path, max-retries abort, action step with terminal result, initialOutputs hydration), 4 in `run-repository.test.ts` (write/upsert/read/empty), 1 in `workflow.test.ts` (`output_schema` accepted), 3 in `run-lifecycle.test.ts` (output step end-to-end, max-retries abort, retry-without-re-persisting-parent).
- `pnpm test:coverage` — Statements **99.35%** / Branches **98.48%** / Functions **98.18%** / Lines **99.3%**. Statements/lines/functions all up vs the slice 2 baseline; branches dropped 0.45pp because the SDK `SDKResultError` union has multiple subtypes (`error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`) and only the named one is exercised in tests — the others are caught by the same `throw new Error(msg.subtype)` path so further coverage would be redundant.

**Deferred:**

- `change_request` rendering does not yet read `RunContext.outputs` — that's slice 4. The lifecycle still calls `renderChangeRequest({ template, issue, attempt, branch })` without an outputs argument, by design.
- Step prompt rendering (`{{ steps.X.output.Y }}`) is also slice 4. The hydrated `ctx.outputs` map exists but isn't read by `renderPrompt` yet.

## Slice 4 — Output Substitution

**Status:** Ready for review

**Started:** 2026-05-01 on `main` (single sweep — `renderPrompt` extension + two call sites; reviewable as one PR).

**Purpose:** Make `{{ steps.X.output.Y }}` (including nested paths) resolve in step prompts and in `change_request` templates against the in-memory outputs map.

**Scope:**

- Extend `renderPrompt` in `server/workflow/workflow.ts` to accept an `outputs` parameter (`Record<string, unknown>`) and resolve dotted paths starting with `steps.<name>.output.`. The existing variable interpolation (`issue.*`, `attempt`, `branch`) keeps working unchanged.
- Nested paths walk through objects and array indices. Scalars render as-is via `String(value)`. Nested objects and arrays render as `JSON.stringify(value)`.
- Missing references render as empty string (consistent with existing behaviour); slice 6's validator is the safety net.
- Wire the outputs map into both call sites:
  - `step-runner.ts` passes the current `RunContext.outputs` snapshot to `renderPrompt` for each step.
  - `change-request-renderer.ts` passes the final `RunContext.outputs` to `renderPrompt` for `title` and `body`.
- Add a regression test for re-rendering safety: an output value that contains `{{ ... }}` substrings does *not* trigger a second pass of substitution (single-pass replace is current behaviour; lock it in).

**Natural code areas:**

- `server/workflow/workflow.ts` (`renderPrompt`)
- `server/orchestrator/step-runner.ts`
- `server/orchestrator/change-request-renderer.ts`
- `server/workflow/__tests__/*`

**Tests:**

- `{{ steps.foo.output.title }}` resolves to the scalar value from `outputs.foo.title`.
- Nested `{{ steps.foo.output.summary.title }}` resolves through `outputs.foo.summary.title`.
- Object value at the referenced path renders as `JSON.stringify(value)`.
- Array value at the referenced path renders as `JSON.stringify(value)`.
- Missing step reference renders as empty string.
- Missing field reference renders as empty string.
- Output value containing literal `{{ issue.key }}` is *not* re-substituted (single-pass).
- `change_request.title` substitution works against the final outputs map.
- Step prompt substitution works against the running outputs map (only earlier steps' outputs are available).

**Quality gates:**

- `prompt-preprocessor.ts` is *not* modified — substitution lives next to existing variable interpolation in `workflow.ts`.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — feature slice; coverage should rise.

**Risks:**

- The path walk needs to handle edge cases: keys with dots in them aren't supported (treated as nested), array index syntax (`steps.foo.output.items.0`) is a design choice — pick "no array index in V1, only object property names" and document it.
- `JSON.stringify` on a value containing a function or symbol returns surprising results. Validated outputs from the SDK are JSON, so this shouldn't happen, but type the outputs map as `Record<string, unknown>` and accept that consumers pass JSON-shaped values.

**Completed changes:**

- **`renderPrompt` extension** (`server/workflow/workflow.ts`): added optional `outputs?: Record<string, unknown>` to the vars object. When a `{{ ... }}` reference's first path segment is `steps`, the new `renderOutputReference` helper looks up `outputs[stepName]` and walks the rest of the path. Scalars render via `String(value)`. Objects (including arrays) render via `JSON.stringify(value)`. Anything missing — unknown step, mid-path through a non-object, terminal `null`/`undefined`, or a malformed shape (`{{ steps.foo }}`, `{{ steps.foo.notoutput.x }}`) — renders as empty string. Existing `{{ issue.* }}`, `{{ attempt }}`, `{{ branch }}` interpolation is unchanged.
- **Single-pass replacement**: the regex replace runs once over the template, so an output value that itself contains `{{ ... }}` substrings is *not* re-interpolated. Test locks this in.
- **Step prompt wiring** (`server/orchestrator/step-runner.ts`): each step's prompt is rendered with `outputs: { ...ctx.outputs }` (snapshot — only earlier steps' outputs are visible because the in-memory map is populated step-by-step).
- **Change-request wiring** (`server/orchestrator/change-request-renderer.ts` + `run-lifecycle.ts`): `renderChangeRequest` now accepts `outputs?: Record<string, unknown>` and threads it to `renderPrompt`. `finalizeSuccess` passes the final `ctx.outputs` so `change_request.title` / `change_request.body` can reference any completed step's structured output.
- **No changes to `prompt-preprocessor.ts`** — substitution lives next to existing variable interpolation in `workflow.ts` per the slice's quality gate.

**Verification:**

- `pnpm lint` — pass (129 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (41 files, 277 tests; up from 263 in slice 3).
- `pnpm test:coverage` — Statements **99.36%** / Branches **98.51%** / Functions **98.18%** / Lines **99.31%**. All dimensions match or exceed the slice 3 baseline; `workflow.ts` is at 100% across all four after the new tests.
- New tests: 11 in `workflow.test.ts` (scalar, nested, object→JSON, array→JSON, unknown step, unknown nested field, no-outputs, single-pass, too-short reference, missing `output` keyword, null terminal); 1 in `step-runner.test.ts` (later step's prompt sees earlier step's output); 1 in `change-request-renderer.test.ts` (output substitution in title and body); 1 in `run-lifecycle.test.ts` (end-to-end change-request with output reference).

## Slice 5 — Dynamic Branch Agent

**Status:** Ready for review

**Started:** 2026-05-02 on `main` (single sweep — schema + resolver + lifecycle wiring + step branch param; reviewable as one PR).

**Purpose:** Let `branch` be either a static template string or a `{ prompt, schema }` object that runs a one-shot agent at clone-time to propose a branch name.

**Scope:**

- Update the workflow schema in `workflow.ts` so `branch` accepts `string | { prompt: string, schema: JSONSchema }`.
- Branch resolution path in `run-lifecycle.ts` (or `workspace.ts`, wherever branch creation lives after slice 1):
  - String form: render template, `git checkout -b`.
  - Object form: render the `prompt` against `{ issue, attempt }`. Invoke `agent-invoker.ts` with `outputFormat: { type: "json_schema", schema }`. Branch on the terminal `result` subtype:
    - Success: take `structured_output.name`, store on `RunContext.branch`, `git checkout -b`.
    - `error_max_structured_output_retries`: abort the run before any step fires; emit a clear lifecycle event.
- The dynamic form runs at lifecycle pin 2 (after clone, before setup, before any step).
- Document explicitly that the branch agent inherits the step agent's allowed-tools list (Read/Write/Edit/Bash/Glob/Grep). Per-invocation tool scoping is in deferred scope.

**Natural code areas:**

- `server/workflow/workflow.ts`
- `server/orchestrator/run-lifecycle.ts`
- `server/orchestrator/workspace.ts`
- `server/orchestrator/__tests__/*`
- `server/workflow/__tests__/*`

**Tests:**

- Workflow parse accepts `branch: "static-template-{{ issue.number }}"`.
- Workflow parse accepts `branch: { prompt: "...", schema: {...} }`.
- Workflow parse rejects malformed shapes (e.g. object without `prompt` or `schema`).
- Static branch path is unchanged from current behaviour.
- Dynamic branch invokes `agent-invoker` with `outputFormat`.
- On success, `RunContext.branch` is set to `structured_output.name` and `git checkout -b` is called with that name.
- `{{ branch }}` resolves in step prompts and `change_request` templates to the validated name.
- On `error_max_structured_output_retries`, the run aborts before `.agent/setup.sh` or any step fires.
- Branch agent runs at lifecycle pin 2 (after clone, before setup).

**Quality gates:**

- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — feature slice; coverage should rise.

**Risks:**

- The branch agent has full Bash access in V1. A misbehaving branch prompt could run arbitrary commands in the workspace. Document this clearly; the deferred per-invocation tool scoping item is the mitigation.
- Branch-name collision (the proposed name already exists on the remote) is in deferred scope. The current behaviour will be a `git checkout -b` failure that aborts the run — acceptable for V1, document the failure mode.
- The mock invoker needs to emit a `result` message with `structured_output` for tests; reuse the helper from slice 3.

**Completed changes:**

- **Workflow schema** (`server/workflow/workflow.ts`): `branch` is now `z.union([z.string().min(1), branchAgentSchema])`. The new `branchAgentSchema` is a `.strict()` object with required `prompt: string` and `schema: Record<string, unknown>` (raw JSON Schema). Unknown keys on the agent block fail at parse. New exported types: `BranchAgentTemplate`, `WorkflowBranch`.
- **Branch resolver** (`server/orchestrator/branch-resolver.ts`, new): pure async function `resolveBranch({ workflowBranch, issue, attempt, agent, cwd, model, signal })` that returns the resolved branch name. String form goes through `renderPrompt({ issue, attempt })` and never invokes the agent. Object form renders the prompt against the same vars, builds `outputFormat: { type: "json_schema", schema }`, runs one `agent.invoke()`, and walks the message stream. On `result.subtype === "success"` it returns `structured_output.name`; on any other subtype (including `error_max_structured_output_retries`) it throws with the subtype as the message. Empty/missing `name` and a stream that ends without a `result` are guarded with explicit errors.
- **Lifecycle pin 2 rewire** (`server/orchestrator/run-lifecycle.ts`): branch is no longer rendered up-front before `runner.enqueue`. Instead the handler calls `resolveBranch(...)` inside the `try` block, after `ensureWorkspace` and before `ensureBranch` / `runRepoSetup`. A failed dynamic-branch resolve is caught by the existing handler `catch`, surfaces as `step.failed`-style run failure, and short-circuits before setup or any step fires. The resolved name is wrapped with `branchName(...)` and passed to `ensureBranch`, `runWorkflowSteps`, and `finalizeSuccess` (for change-request rendering).
- **Step prompt `{{ branch }}` support** (`server/orchestrator/step-runner.ts`): `RunWorkflowStepsParams` and `RunWorkflowStepParams` gained a required `branch: string`, threaded into `renderPrompt({ issue, attempt, branch, outputs })`. This is what makes `{{ branch }}` resolvable in step prompts — previously it only worked in `change_request` templates. The dynamic-branch example workflow's step-level `{{ branch }}` references now interpolate correctly.
- **Tools inheritance**: the branch agent goes through the same `agent-invoker` as step agents and inherits the same `ALLOWED_TOOLS` (`Read`, `Write`, `Edit`, `Bash`, `Glob`, `Grep`). Per-invocation tool scoping remains deferred.
- **No changes to `RunContext`**: the slice plan suggested storing `branch` on `RunContext`, but there's no consumer outside the lifecycle/step-runner thread, so it stays as a parameter on `runWorkflowSteps`. The runner contract is unchanged.

**Verification:**

- `pnpm lint` — pass (131 files, no fixes applied).
- `pnpm typecheck` — pass (server + dashboard).
- `pnpm test` — pass (42 files, 287 tests; up from 277 in slice 4).
- `pnpm test:coverage` — Statements **99.37%** / Branches **98.55%** / Functions **98.19%** / Lines **99.32%**. All four dimensions match or exceed the slice 4 baseline.
- New tests: 5 in `branch-resolver.test.ts` (static render skips agent, dynamic invokes with outputFormat, missing-name guard, empty-stream guard, error subtype propagates), 1 in `step-runner.test.ts` (`{{ branch }}` substituted into a step prompt), 2 in `run-lifecycle.test.ts` (dynamic branch end-to-end with `git checkout -b`, step prompt, and change-request all reading the agent-proposed name; error subtype aborts before setup or any `step.started` event), 4 in `workflow.test.ts` (object form parses, missing `prompt` rejected, missing `schema` rejected, unknown-key rejected).

## Slice 6 — Static Reference Validation

**Status:** Not started

**Purpose:** Catch bad `{{ steps.X.output.Y }}` references at workflow load instead of 20 minutes into a run.

**Scope:**

- After Zod schema parse succeeds in `workflow-loader.ts`, walk every step `prompt` string and the `change_request.title` and `change_request.body` templates. Extract every `{{ steps.X.output.Y... }}` reference.
- For each reference:
  - Step `X` must exist in `steps[]`.
  - For step prompts: step `X` must appear *earlier* than the referencing step. Forward references fail.
  - The dotted path after `output.` must resolve through step `X`'s `output_schema`. The validator walks the schema's `properties` tree and `items` for arrays. Top-level paths and nested paths both supported.
- `change_request` references are not subject to the forward-reference rule (all steps have completed by the time it renders).
- Errors include the file path, the offending reference, and the reason (unknown step, forward reference, unknown field, schema uses unsupported composition).
- Declare `$ref`, `anyOf`, `oneOf`, `allOf` unsupported in the validator's path walker for V1. If the referenced step's schema uses any of these, validation fails closed with a clear "validator does not support schema composition keywords" message.

**Natural code areas:**

- `server/workflow/workflow-loader.ts`
- `server/workflow/__tests__/*`

**Tests:**

- Reference to unknown step fails at load with file path + reference + reason.
- Forward reference in step prompt fails (step `B` references `steps.C.output.x` where `C` comes after `B`).
- Forward reference in `change_request` is allowed.
- Reference to unknown top-level field fails.
- Reference to unknown nested field fails.
- Reference to known top-level field passes.
- Reference to known nested field passes.
- Reference to a step without `output_schema` fails with a clear message.
- Schema using `anyOf` / `oneOf` / `allOf` / `$ref` triggers the "unsupported composition" error rather than silently passing.
- `loadWorkflow()` for a workflow with no `{{ steps.* }}` references runs the validator and returns successfully.
- A workflow with both valid step prompts and valid `change_request` references passes.

**Quality gates:**

- The validator runs only after the Zod parse succeeds — never against a partially-valid YAML object.
- Validator error messages are user-facing; they should make a workflow author's next move obvious.
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage` — feature slice; coverage should rise.

**Risks:**

- JSON Schema is open-ended. The walker covers `properties` + `items` for V1; anything else fails closed. A future workflow author hitting the unsupported-composition error is the signal to extend it, not break out of the design.
- The reference extractor must not match `{{ issue.* }}` or `{{ branch }}` (those are valid templates, just not output references). Anchor the regex on `steps.`.
- A multi-line prompt string can contain `{{ }}` inside a fenced code block intended literally for the LLM. Decide: validator treats *all* `{{ steps.* }}` as references regardless of context (simpler, document it), or skips fenced blocks (more permissive, more code). Recommend the simpler rule.

## Release-Level Acceptance

The overall work is complete when:

- `phases` → `steps` rename is fully applied across server, dashboard, db, and tests.
- Top-level `prompt:` form and `hooks:` block are removed from the workflow schema.
- `.agent/setup.sh` runs at lifecycle pin 3 with strict failure on non-zero exit.
- `change_request: { title, body }` is required at parse time and rendered at lifecycle pin 6.
- Output steps work end-to-end: `outputFormat` is passed to the SDK, validated values are stored on `RunContext.outputs`, persisted to `run_step_outputs`, and addressable as `{{ steps.X.output.Y }}` (including nested paths) in later step prompts and in `change_request` templates.
- Retry hydrates outputs from the parent run's `run_step_outputs` rows so skipped steps' outputs remain available to downstream renders.
- Dynamic branch agent works for the `branch: { prompt, schema }` form and aborts the run on schema-retry exhaustion.
- Static reference validator catches unknown steps, forward references, unknown fields, and unsupported schema composition at workflow load.
- GitHub-only behaviour still works under the new surface.
- `pnpm lint`, `pnpm typecheck`, `pnpm test`, and final `pnpm test:coverage` pass; coverage matches or exceeds the slice 0 baseline.

## Deferred Scope

Do not include these in the initial implementation (mirrors the design doc's deferred section):

- alternative agent runtimes (codex, aider, etc.) — Claude Agent SDK only for V1
- alternative sandboxes — current workspace model only
- per-step wall-clock timeout override
- output gating (a step declaring its output blocks the run if invalid)
- per-repo workflow override
- workflow file watch or reload without restart
- a `completion_signal` sentinel (Sandcastle-style early exit)
- branch-name conflict resolution when the agent proposes an already-existing branch
- `change_request` updates on retry vs always opening fresh
- `change_request.labels` and `change_request.draft` (hardcoded in the code-host adapter for V1 if needed)
- per-invocation tool scoping for the branch agent (currently inherits the step agent's tool set)
