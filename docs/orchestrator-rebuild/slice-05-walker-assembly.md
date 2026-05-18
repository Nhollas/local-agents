# Slice 5 — Walker assembly + `run-lifecycle` rebuild

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), [`../../orchestrator-effect-prototype/src/variants/v4-composed.ts`](../../orchestrator-effect-prototype/src/variants/v4-composed.ts) (the composition shape), and the existing `server/orchestrator/run-lifecycle.ts` (the imperative behaviour being replaced). The orchestrator integration tests (`orchestrator.*.integration.test.ts`) are the survival bar.

## What to build

The payoff slice. Assemble the nine phases from slices 2–4 into one walker, wire it into a rewritten `run-lifecycle.ts`, and delete everything the rewrite makes obsolete.

The walker (`server/orchestrator/walker.ts`):

```ts
export const runLifecycleWalker = Effect.gen(function* () {
  const lastState = yield* Ref.make<RunState>({});
  const breadcrumb = yield* makeBreadcrumbEmitter; // emits `system` events via RunContext + writes canonicalLog
  const observe = withObservability({ lastState, recordBreadcrumb: breadcrumb });

  return yield* observe("workspace", phases.workspace)({}).pipe(
    Effect.flatMap(observe("branch_resolver", phases.branchResolver)),
    Effect.flatMap(observe("ensure_branch", phases.ensureBranch)),
    Effect.flatMap(observe("skills", phases.skills)),
    Effect.flatMap(observe("setup", phases.setup)),
    Effect.flatMap(observe("steps", phases.steps)),
    Effect.flatMap(observe("push", phases.push)),
    Effect.flatMap(observe("change_request", phases.changeRequest)),
    Effect.flatMap(observe("tracker", phases.tracker)),
    Effect.matchEffect({
      onSuccess: (state) =>
        Effect.succeed<RunResult>({ status: "completed", state }),
      onFailure: (err) =>
        Ref.get(lastState).pipe(
          Effect.map((state): RunResult => ({
            status: "failed",
            phase: err.phase,
            cause: err.cause,
            state,
          })),
        ),
    }),
  );
});
```

The rewritten `run-lifecycle.ts`:

```ts
function dispatch(req: RunRequest): Effect.Effect<RunHandle, never, OrchestratorServices> {
  return Effect.gen(function* () {
    const { issue, repo, workflow } = req;
    const baseBranch = yield* codeHost.defaultBranch(repo);
    const cloneUrl = codeHost.cloneUrl(repo);

    return yield* runner.enqueue({
      repo, repoUrl: codeHost.repoUrl(repo),
      issueKey: issue.key, issueTitle: issue.title, issueUrl: issue.url,
      handler: (ctx) =>
        Effect.gen(function* () {
          const eventQueue = yield* Queue.unbounded<WorkflowEvent>();
          const consumer = yield* Effect.fork(
            consumeWorkflowEvents(eventQueue, { runRepo, ctx, runId: ctx.runId, cwd: ?, logger, steps: workflow.steps }),
          );

          const perRunLayers = Layer.mergeAll(
            Layer.succeed(AgentInvoker, agentFactory({ cwd: ?, runId: ctx.runId, signal: ctx.signal })),
            WorkflowEventEmitterLive(eventQueue),
            Layer.succeed(PhaseInputs, makePhaseInputs({ issue, repo, cloneUrl, baseBranch, runId: ctx.runId, workspaceRoot, skillsSourceDir, agentEnv, scope, workflow })),
            Layer.succeed(RunContext, ctx),
          );

          const result = yield* runLifecycleWalker.pipe(Effect.provide(perRunLayers));
          yield* Queue.shutdown(eventQueue);
          yield* Fiber.join(consumer);

          if (result.status === "completed") {
            yield* removeWorkspace(result.state.wsPath!);
          } else {
            yield* markIssueFailed(repo, issue).pipe(Effect.ignoreLogged);
          }
          return phaseResultToRunResult(result, startTime);
        }),
    });
  });
}
```

(The sketch above is illustrative — the implementer fills in the cwd-resolution edge cases and the exact `RunResult` shape mapping. The point is: one `Effect.gen`, one walker call, no `runOrch` wrapper, no per-phase try/catch.)

The `withObservability` decorator from slice 1 is **enriched** in this slice:

- Replace the no-op `recordBreadcrumb` with the real emitter — a function that emits `system` events on `RunContext` and writes canonical-log aggregates per phase.
- Add `Effect.withSpan(phase_<name>)` per phase, replacing the imperative `runRunSpan` block.
- On phase failure, set `canonicalLog { failure_phase, failure_error }` — replacing the imperative `recordFailure` helper.

The chunk-of-imperative-code-to-delete budget for this slice:

- `runOrch` helper, `recordFailure` helper, `formatExecError` helper — all gone. Their jobs are now done by `Effect.mapError(PhaseFailure)`, `withObservability`, and Effect's own `Cause`-aware error rendering.
- The big `try { ... } catch (err) { ... } finally { ... }` block in `dispatch` — gone. Replaced by `Effect.matchEffect` at the walker exit.
- The `runRunSpan` block — replaced by `Effect.withSpan` on the walker and per-phase spans inside `withObservability`.
- The hand-written `workflowRuntime.runPromise(consumeWorkflowEvents(...))` await dance — replaced by `Effect.fork` + `Fiber.join`.

## Acceptance criteria

- [ ] `server/orchestrator/walker.ts` exists and composes the nine phases via `Effect.flatMap` exactly as in the locked sketch.
- [ ] `server/orchestrator/run-lifecycle.ts` body is a single `Effect.gen` — no try/catch, no `runOrch`, no `recordFailure`, no `formatExecError`. The latter three helpers are deleted.
- [ ] `withObservability` writes canonical-log aggregates and opens per-phase spans; phase bodies contain none of that machinery.
- [ ] Per-run layers (`AgentInvoker`, `WorkflowEventEmitter`, `PhaseInputs`, `RunContext`) provided once at the walker entry — phases declare requirements via Tag, never call `Effect.provide` inline.
- [ ] Event-consumer fiber is forked via `Effect.fork` and awaited via `Fiber.join`; no `workflowRuntime.runPromise` wrapper around it.
- [ ] Workspace is removed on full success only; failed runs retain the workspace for inspection (matches existing behaviour).
- [ ] `markIssueFailed` warn-and-continue semantics preserved (failure to mark the issue failed does not throw — matches the `feedback_logging_must_not_crash` rule).
- [ ] Finalize order matches ADR 0001: push → change_request → tracker.
- [ ] All `orchestrator.*.integration.test.ts` files pass unchanged.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 2 (pre-engine phases)
- Slice 3 (engine phases)
- Slice 4 (finalize phases)
