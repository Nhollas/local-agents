# Slice 7 — Runtime consolidation

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md) (specifically the "per-module `runtime.ts` is transitional" rule), and `server/server.ts`. The runner-migration lessons #6 (parallel disposal) and #7 (test cleanup) apply directly.

## What to build

Collapse the five per-module `ManagedRuntime` files into a single top-level runtime in `server.ts`. After this slice, the destination from `migration-standards.md` is reached: one runtime at the top of the process, every module exposes raw `Effect.Effect<A, E, R>` signatures, the `*/runtime.ts` files are gone.

Delete:

- `server/code-hosts/runtime.ts`
- `server/runner/runtime.ts`
- `server/trackers/runtime.ts`
- `server/workflow/runtime.ts`
- `server/orchestrator/runtime.ts`

Create or extend in `server/server.ts`:

```ts
const AppLayer = Layer.mergeAll(
  NodeContext.layer,                        // FileSystem, CommandExecutor, etc. from @effect/platform-node
  CodeHostLayer(config),
  TrackerLayer(config),
  RunnerLayer,
  WorkflowLayer(config),
  OrchestratorLayer(config),
);

const runtime = ManagedRuntime.make(AppLayer);

await runtime.runPromise(orchestrator.start);
// ... HTTP server uses runtime.runPromise(...) at the request boundary ...

process.on("SIGTERM", () => {
  void runtime.dispose();
});
```

Each module exports a `Layer` (e.g. `CodeHostLayer`, `WorkflowLayer`) from a module-level `index.ts` or similar — those layers compose the module's services and depend on lower layers. The `ManagedRuntime.make(AppLayer)` is the **only** runtime in the process.

Test scaffolding follows the runner-migration lesson #7 pattern — wherever a test today constructs a per-module runtime, replace with a per-test `ManagedRuntime.make(...)` over a test-scoped Layer, captured in a `runtimes[]` array, and disposed in parallel via `Promise.all` in `afterEach`. Apply this consistently across `code-hosts`, `trackers`, `runner`, `workflow`, and `orchestrator` test files — any of them that today instantiate a runtime per test.

The runtime-disposal at shutdown is `Promise.all`-parallel, not sequential (runner-migration lesson #6).

## Acceptance criteria

- [ ] The five `*/runtime.ts` files are deleted.
- [ ] `server.ts` constructs exactly one `ManagedRuntime` via `Layer.mergeAll(...)` over all module Layers.
- [ ] Every module exposes a Layer factory (`CodeHostLayer`, `TrackerLayer`, `RunnerLayer`, `WorkflowLayer`, `OrchestratorLayer`) — no module exports a runtime.
- [ ] No file outside `server.ts` calls `ManagedRuntime.make`.
- [ ] HTTP request handlers run effects via `runtime.runPromise` (or `runtime.runFork` for streaming) — one well-named helper, not per-route boilerplate.
- [ ] Test files that previously held per-module runtimes use the `runtimes[]` + `Promise.all`-dispose pattern from runner-migration lesson #7.
- [ ] Shutdown disposes independent resources in parallel (`Promise.all`), per runner-migration lesson #6.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green — including all integration tests across all modules.

## Blocked by

- Slice 6 (`orchestrator.ts` already on Effect surface)
