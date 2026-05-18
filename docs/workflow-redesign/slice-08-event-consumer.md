# Slice 8 — `event-consumer` fiber + `run-lifecycle.ts` per-run wiring

## What to build

The orchestrator-side payoff. After this slice, the engine's `WorkflowEvent` stream is the *only* seam between engine and orchestrator, and the bridging files are gone.

- `orchestrator/event-consumer.ts` (new) — forked fiber that drains the per-run `Queue<WorkflowEvent>` and dispatches each event to:
  - `runRepo` writes (`startStep` / `completeStep` / `failStep` / `writeStepOutput` / `addRunUsage` / `branch` / `error`)
  - SSE via `ctx.emit`
  - canonical log bag (aggregations from `semantic-cases.md` → "Slice 8")
  - OTel spans for `StepStarted` / `StepCompleted` / `StepFailed`
  - `measure_diff` after `StepCompleted` for steps with `measure_diff: true` (consumes `parse-shortstat.ts`)
- Update `orchestrator/run-lifecycle.ts` with the per-run wiring sketch from the prototype:

```ts
const eventQueue    = yield* Queue.unbounded<WorkflowEvent>();
const consumerFiber = yield* Effect.fork(consumeEvents(eventQueue, ...));

const perRunLayers = Layer.mergeAll(
  AgentInvokerLive({ logDir, env }),
  WorkflowEventEmitterLive(eventQueue),
);

yield* Effect.all([
  engine.resolveBranch(workflow.branch, scope),
  // ... checkout, bootstrap ...
  engine.runSteps(workflow.steps, scope, branch, cwd),
  // ... push ...
]).pipe(Effect.provide(perRunLayers));
```

- **Delete** `orchestrator/agent-logging.ts` and `orchestrator/agent-metrics.ts`. Their logic is absorbed into `event-consumer.ts`.

The transcript / tool-use rendering from the old `agent-logging.ts` (path normalisation, `tool:read` / `tool:edit` / `tool:bash` / `tool:other` derivation, `tool_use_by_name` counter, etc.) moves into the consumer's `*AssistantMessage` handler. All cases listed under "Slice 8" in `semantic-cases.md` must be covered.

## Acceptance criteria

- [ ] `orchestrator/agent-logging.ts` and `orchestrator/agent-metrics.ts` deleted.
- [ ] `event-consumer.ts` exists; subscribes to the per-run queue; routes each event to repo / SSE / canonical log / telemetry / `measure_diff` as appropriate.
- [ ] `run-lifecycle.ts` uses `Layer.mergeAll(AgentInvokerLive(...), WorkflowEventEmitterLive(queue))` and `Effect.provide(perRunLayers)` around each engine call.
- [ ] Consumer fiber lifecycle is tied to the run — created on run start, awaited / interrupted on run end. Shutdown of independent resources is parallelised (`Promise.all`-style), per `migration-standards.md`.
- [ ] Canonical log bag receives every aggregate listed under "Slice 8" in `semantic-cases.md` (`steps_total`, `step_durations_ms`, `total_cost_usd`, `models_used`, `tool_use_by_name`, `failed_step`, etc.).
- [ ] Path-normalisation behaviour (including the `/private` symlink prefix on macOS) preserved for `tool:read` / `tool:grep` / `tool:bash`.
- [ ] All semantic cases listed under "Slice 8" in `semantic-cases.md` covered by new tests.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green — including the orchestrator integration tests (`orchestrator.*.integration.test.ts`).

## Blocked by

- Slice 5 (`BranchResolved` / `BranchFailed` events to consume)
- Slice 6 (`Step*` events to consume — the bulk of the consumer's work)
- Slice 7 (`renderChangeRequest` is called from `run-lifecycle.ts` alongside the wiring change)
