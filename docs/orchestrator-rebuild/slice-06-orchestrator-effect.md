# Slice 6 — `orchestrator.ts` surface goes Effect

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), and the existing `server/orchestrator/orchestrator.ts`. The dispatch / scheduling integration tests (`orchestrator.dispatch-multi-repo.integration.test.ts`, `orchestrator.scheduling.integration.test.ts`, `orchestrator.queue.integration.test.ts`, `orchestrator.recovery.integration.test.ts`) are the survival bar.

## What to build

The orchestrator's public surface — `dispatch`, the queueing logic, the scheduling tick, the workspace sweep — goes from Promise-returning to Effect-returning. Callers in `server.ts` and `api/` move to a single `runtime.runPromise(...)` boundary at the very edge.

Touch `server/orchestrator/orchestrator.ts`:

- The internal Promise machinery (`Promise.all` over per-repo dispatches, the `setInterval` scheduling loop, the workspace-sweep timer) ports to Effect equivalents — `Effect.all`, `Effect.repeat` with `Schedule.spaced`, `Effect.forkDaemon` for long-running loops.
- The public `Orchestrator` shape becomes `{ dispatch: (req) => Effect<RunHandle, ...>; sweepNow: () => Effect<void, ...>; start: () => Effect<Fiber<...>, ...>; }` — no Promise on the type surface.
- `createOrchestrator(deps)` returns an `Effect` that produces the orchestrator value (so it can compose into a `Layer` in slice 7) — not a synchronous factory.
- `clock.ts`: replace the `Clock` interface with `effect/Clock.Clock`. The `systemClock` factory is gone — fall through to Effect's built-in clock.
- `sweepWorkspaces` (in `workspace.ts`, already Effect) is invoked via `Effect.forkDaemon(sweepWorkspaces(...).pipe(Effect.repeat(Schedule.spaced("1 hour"))))` inside `start()`. The current `setInterval` lifecycle is gone.

Callers update:

- `server.ts` calls `runtime.runPromise(orchestrator.start)` once at boot. All other call sites consume the Effect surface directly.
- `api/` route handlers that today await `orchestrator.dispatch(...)` move to running the Effect via the shared runtime — this should be one well-named helper (e.g. `runApiEffect`) shared across handlers, not sprinkled inline.

The runtime that runs all of this is **still** the per-module `orchestratorRuntime` for now — slice 7 collapses it. The point of this slice is to flip the orchestrator's surface, not to consolidate runtimes yet.

## Acceptance criteria

- [ ] `Orchestrator` type surface returns `Effect.Effect<...>` everywhere — no `Promise` in any exported signature.
- [ ] `dispatch`, `sweepNow`, `start` are Effect values.
- [ ] `setInterval` / `clearInterval` are gone. Scheduling uses `Effect.repeat` + `Schedule`. Long-running loops are `Effect.forkDaemon`.
- [ ] `clock.ts` uses `effect/Clock.Clock` or is deleted entirely if no longer needed.
- [ ] `server.ts` has exactly one `runtime.runPromise(...)` call for the orchestrator boot path; route handlers route through a single shared `runApiEffect` (or equivalent) helper.
- [ ] `orchestrator.*.integration.test.ts` files pass — adjust setup to construct the orchestrator via Effect, not via direct Promise factories. Test bodies (assertions on behaviour) should not change.
- [ ] No `as` casts, no Zod, no interface wrappers around Effect-returning functions.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 5 (`run-lifecycle.dispatch` is the input to this slice's `orchestrator.dispatch`)
