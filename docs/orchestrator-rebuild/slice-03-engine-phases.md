# Slice 3 — Engine phases as files

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), and the **engine entrypoint signatures** in `server/workflow/resolve-branch.ts` and `server/workflow/run-steps.ts`. Skim the `branch_resolver` and `step` blocks of `run-lifecycle.ts` for the behaviour to preserve.

## What to build

The two phases that drive the workflow engine. Same `Phase` shape as slice 2, but these phases call into already-migrated workflow modules that require `AgentInvoker` + `WorkflowEventEmitter` Service Tags — those Tags are supplied per-run by the walker (slice 5).

Land in `server/orchestrator/phases/`:

- `branch-resolver.ts` — wraps `resolveBranch(workflow.branch, scope)`. Populates `state.branch`. Sets `runRepo.setRunBranch` as a tap.
- `steps.ts` — wraps `runSteps(workflow.steps, scope, branch, wsPath, workspaceEnv)`. Populates `state.outputs`. Requires `state.branch` and `state.workspaceEnv` from earlier phases. Note this also requires `runRepo.insertSteps(...)` to have happened — that side-effect moves into a phase tap or a one-time call inside `run-lifecycle.ts` before the walker (judgement call left to the implementer; pick whichever places the side-effect closest to its data).

Locked: phases consume `scope: PromptScope` and `workflow: RepoWorkflow` from the same `PhaseInputs` Service Tag introduced in slice 2 (extend its shape with `scope` and `workflow` here).

Per-run layers — these phases declare `AgentInvoker | WorkflowEventEmitter` in their `R` channel. They do **not** call `Effect.provide(perRunLayers)` themselves — that happens once at the walker entrypoint in slice 5. Letting the requirement bubble up is the whole point of using Service Tags.

## Acceptance criteria

- [ ] Two phase files exist under `server/orchestrator/phases/`, each exporting an Effect value matching the `Phase` signature.
- [ ] `branch-resolver.ts` and `steps.ts` declare `AgentInvoker | WorkflowEventEmitter` in their `R` channel — they do not `Effect.provide` inline.
- [ ] Native `WorkflowExecutionError` values fold into `PhaseFailure` via `Effect.mapError`.
- [ ] `PhaseInputs` shape extended with `scope: PromptScope` and `workflow: RepoWorkflow`.
- [ ] `run-lifecycle.ts` still works as it did — these phase files are unused so far. The walker swap happens in slice 5.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (`Phase` signature, `PhaseFailure`)
- Slice 2 (`PhaseInputs` Service Tag)
