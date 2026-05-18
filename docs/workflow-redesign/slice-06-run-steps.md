# Slice 6 — `runSteps` via `runAgentTurn` (delete `step-runner.ts`)

## What to build

Second workflow phase converted end-to-end. Land:

- `workflow/run-steps.ts` — public `runSteps` entrypoint. Loops `runAgentTurn` (one turn per step), threads `resume_previous` session-id, and feeds `steps.<name>.output` into subsequent prompts via the scope.
- Delete `server/orchestrator/step-runner.ts`.
- Update `run-lifecycle.ts` to call `engine.runSteps(workflow.steps, scope, branch, cwd, env)` directly.

Signature:

```ts
runSteps: (
  steps: ReadonlyArray<WorkflowStep>,
  scope: PromptScope,
  branch: string,
  cwd: string,
  env?: Record<string, string>,
) => Effect<
  Record<string, unknown>,
  WorkflowExecutionError,
  AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem
>
```

Event sequence per step (per slice 4 table): `StepStarted` → (zero or more `StepAssistantMessage` / `StepToolFailure`) → `StepResult` → `StepCompleted`. On failure: `StepStarted` → `StepResult` (with the failing usage) → `StepFailed`. Loop aborts on the first `StepFailed`.

**Aggregation moves consumer-side.** The engine no longer aggregates cost/tokens or counts steps — it emits one `StepResult` per step with that step's usage and lets `event-consumer` (slice 8) sum them. This is the deliberate "observability lives on boundaries" simplification from `migration-standards.md`.

The semantics that must survive are listed in [`semantic-cases.md`](semantic-cases.md) under "Slice 6".

## Acceptance criteria

- [ ] `runSteps` consumes `AgentInvoker` + `WorkflowEventEmitter` via Service Tags.
- [ ] Action steps (no `output_schema`) don't pass `outputSchema`; any structured output on the result is ignored — no `StepResult.structuredOutput`.
- [ ] Output steps decode structured output, include it in the returned `outputs` map keyed by step name, and emit it on `StepResult`.
- [ ] `resume_previous: true` threads the previous turn's `sessionId` into the next `runAgentTurn`.
- [ ] `{{ steps.<name>.output.<field> }}` references resolve against accumulated outputs in later prompts.
- [ ] `env` propagates to each invoker call.
- [ ] `allowed_tools` forwarded only when present.
- [ ] Per-step `model` passed through unchanged.
- [ ] First `StepFailed` aborts the loop — subsequent steps are not invoked.
- [ ] All semantic cases listed under "Slice 6" in `semantic-cases.md` covered by new tests on event sequences + outputs map + error tags.
- [ ] `orchestrator/step-runner.ts` deleted.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 5 (`runAgentTurn` lands there)
