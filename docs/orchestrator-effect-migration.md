# Orchestrator Effect migration — handoff

Plan and notes for migrating `server/orchestrator/` to Effect. The four prior modules (trackers, code-hosts, workflow, runner) are already migrated and are the reference. Read this before starting work on the orchestrator.

## Framing: this is a rebuild, not a port

Read this before anything else. The previous handoff for the trackers was too literal — "convert current code to Effect" — and the agent dutifully preserved patterns that Effect makes obsolete. Don't repeat that.

- **Be brutalist.** Actively strip legacy patterns Effect's primitives replace. Don't carry forward shapes just because they exist.
- **Hold-overs to actively rip out, not preserve:**
  - Zod validators → `effect/Schema`.
  - `isRecord` and hand-rolled type guards — code smell for skipped schema work.
  - `as` casts in newly-migrated code. Effect prides itself on type safety; casts mean you skipped a step.
  - Still-unsafe complex helpers (e.g. anything resembling `prompt-preprocessor.ts`).
- **Schema returns parsed values, not strings to re-parse downstream.** If a consumer has to split `issue.key` to recover `issueNumber`, the schema is wrong. Push parsing into the schema.
- **No separate module interface / module-type declarations.** Don't wrap an Effect-returning module behind a hand-written `interface` or type alias — it erases Effect's declarative return / error / requirement types, which are the whole point. Let consumers see the real `Effect.Effect<A, E, R>` signatures.
- **Delete ceremony wrappers.** If a method exists only to bridge to a Promise or add no-op annotations, delete it. (`jira-tracker.ts`'s `run()` wrapper was a casualty of this — once observability got trimmed, it did nothing and was removed.)
- **No one-line helper wrappers around a generic HTTP method.** `putVoid` / `postJson` / `getJson` / `sendVoid` etc. — every one re-setting the same cache tags and timeout is a bad, hard-to-read abstraction.
- **No Effect-flavoured pre-optimisation.** No caches, no `Disposable` wrappers, no Layer ceremony "because Effect supports it." Going all-in on Effect ≠ adopting every machinery upfront.
- **Observability lives on boundaries, not internal methods.** Instrument inputs/outputs of meaningful boundaries. Don't sprinkle spans/annotations on every method.
- **No partial migrations.** Once a module is in, it's all in. When the last tracker landed, the bridging junk got deleted: interface collapsed, `Effect.runPromise` pushed up to `server.ts`. Aim for that same endgame here.
- **Per-module `runtime.ts` is transitional, not the destination.** End state is one runtime at the top of the process. The orchestrator phase plan should be moving toward collapsing runtimes, not multiplying them — by the time `orchestrator.ts` is migrated, this is the moment to consolidate.
- **Reach for the right `@effect/*` sub-package; consult `repos/effect`.** `@effect/platform`'s `Command`, `FileSystem`, `HttpClient` etc. exist — use them instead of re-deriving Promise/child_process/fs logic. When unsure, read `repos/effect/packages/*` and `repos/effect/AGENTS.md`.

## Why this is a staged migration, not one pass

The orchestrator is ~5400 LOC across many files with deep coupling between scheduling, lifecycle, and step execution. Trying it in a single PR will produce an unreviewable diff and bury the kind of clarity-focused rebuild the user wants. The plan below breaks it into independent phases. Each phase is its own PR, ships with `pnpm typecheck && pnpm test` green, and is a sensible stopping point.

The four already-migrated modules are the template:

- `588d187` feat: migrate Jira tracker to Effect
- `32b64d5` feat: migrate code hosts to Effect and extract shared HTTP client
- `b644841` feat: migrate workflow module to Effect
- `c1f3c53` feat: migrate runner module to Effect ← **most recent, look here first**

Each adds a sibling `runtime.ts` with a `ManagedRuntime` + `Layer`. Copy that pattern.

## Phases

Every phase follows the framing above: rebuild, not port. That means each phase ends with the migrated code (a) free of Zod / `isRecord` / `as` casts / ceremony wrappers, (b) exposing real `Effect.Effect<A, E, R>` signatures rather than hand-written interfaces, and (c) leaning on `@effect/platform` primitives where they apply. If a phase ships without that audit, it isn't done.

### Phase 1 — Foundation

Add `server/orchestrator/runtime.ts` (`ManagedRuntime` + `Layer`, same shape as `server/runner/runtime.ts`). Wire `dispose()` into `server.ts` shutdown and `server/test-support/test-orchestrator.ts` teardown. Zero logic changes; ~30 lines.

This is a **transitional scaffold**, not the destination. The end-state (see Phase 6) is one runtime at the top of the process and these per-module ones collapsed. Don't grow this file beyond what the staged migration needs.

### Phase 2 — Leaf helpers

`parse-shortstat.ts`, `change-request-renderer.ts`, `branch-resolver.ts`, `clock.ts`, `run-log-file.ts`. Pure or trivially-IO. Each file gets one of two outcomes: migrated to Effect, or left alone because it has no runtime boundary to cross. No "half-migrated wrapping a Promise" middle ground — that violates the no-partial-migrations rule.

### Phase 3 — `workspace.ts`

274 LOC + 580-line test file. Self-contained, mostly filesystem ops. Lean on `@effect/platform-node`'s `FileSystem` like `workflow/` already does. Expect to strip any hand-rolled `fs/promises` paths, `isRecord`-style guards, and Zod schemas in or near this file.

### Phase 4 — `step-runner.ts`

302 LOC + 873-line test file. Step execution. Depends on workflow (already migrated) and workspace (just migrated). Bigger test surface; budget for it. Watch for ceremony wrappers around the workflow/workspace calls — if a method exists only to bridge an Effect back to a Promise, delete it and let the caller hold the Effect.

### Phase 5 — `run-lifecycle.ts`

445 LOC. Per-run dispatch / finalize. Tightly coupled to runner + trackers + code-hosts — all already migrated, so the integration points should be clean Effect APIs. If you find yourself writing `Effect.runPromise` to talk to them, stop — that's a sign the bridging junk needs collapsing, not preserving.

### Phase 6 — `orchestrator.ts` + runtime consolidation

397 LOC. Top-level tick / scheduling / recovery. Last because it integrates everything below it. Two things happen in this phase:

1. **Rebuild for clarity.** Plan a separate read-through pass before writing code; understand the tick loop and recovery semantics first. This is where the "rampant" comment really bites.
2. **Collapse the runtimes.** By the time this phase lands, trackers / code-hosts / workflow / runner / orchestrator each have their own `runtime.ts`. That was always transitional. This is the moment to consolidate to a single top-level runtime in `server.ts` and delete the per-module ones. If that consolidation isn't part of this phase's PR, the migration isn't done.

### Phase 7 — `agent-*`

`agent-hooks.ts`, `agent-invoker.ts`, `agent-logging.ts`, `agent-metrics.ts`, `agent-env.ts`. These get migrated fully — no "only touch what's needed" carve-out, because partial migrations are not acceptable. If a file genuinely has no Effect-shaped work to do, leave it untouched; otherwise it goes all the way over.

## Note on HTTP

The orchestrator doesn't do HTTP directly — it calls into trackers / code-hosts / workflow / runner, all four already migrated and already speaking Effect-flavoured APIs. So the scary Effect-HTTP DSL (the `req.pipe(HttpClientRequest.setHeader(...), ...)` style in `server/code-hosts/github-client.ts`) is **already done** and you shouldn't be writing much of it here.

## Lessons from the runner migration — do NOT repeat these

The user pushed back hard on the first cut of the runner. Don't make the same mistakes:

### 1. Don't leak Effect's vocabulary into our domain names

Function and variable names should describe **what the thing is in our domain**, not what Effect calls it. The runner originally had `trackFiber`, `awaitResult`, `activeFibers`, `body`, `done`. User's words: *"why are we sort of renaming methods and variables based on effects language ... I don't think we should be leaking package language into our code."*

Renames that worked:
- `activeFibers` → `inflightRuns`
- `body` (the inline Effect program) → name the function after what it does: `executeJob`, not the Effect-shaped noun
- `done: Promise<RunResult>` on the public handle → `result: Promise<RunResult>`
- `trackFiber`/`awaitResult` (two helpers, both took a `Fiber`) → inlined into `enqueue` as one observer

The Fiber type itself can't be renamed — but it should only appear in internal type annotations, never in user-facing function names.

### 2. Don't write big inline `Effect.uninterruptibleMask(...)` blobs

First cut had a ~110-line `Effect.gen` inline inside `enqueue`. User: *"damn it's a lot to unpack."*

Break the Effect composition into named functions that read like a description:

```ts
function enqueue(job): RunHandle {
  const id = newRunId();
  recordRunStarted(id, job);
  const inflight = runtime.runFork(executeJob(id, job));
  // ... register + result promise ...
}

function executeJob(id, job): Effect.Effect<RunResult, never> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const outcome = yield* invokeHandler(restore, id, job);
      yield* persistOutcome(id, outcome);
      return outcome.result;
    }),
  );
}
```

Each step gets a name. The composition is three lines.

### 3. Don't use string-equality sentinels for structural state

First cut detected interrupt by comparing `result.error === ABORT_ERROR`. Fragile — any handler that legitimately returns that exact string is misclassified. Detect structurally: `Exit.isFailure(exit) && Cause.isInterruptedOnly(exit.cause)`. Then `ABORT_ERROR` becomes purely the user-facing message emitted on `run:failed`, not a sentinel.

### 4. Don't double-wrap with `Effect.uninterruptible` inside `Effect.uninterruptibleMask`

Inside `uninterruptibleMask`, the default region is already uninterruptible — only the `restore(...)` block flips back. Wrapping a non-restored `Effect.sync` in `Effect.uninterruptible` is a no-op.

### 5. Dedupe Exit/Cause folding

First cut had two near-identical `Exit.match { onSuccess / onFailure with isInterruptedOnly / failureOption / pretty(cause) }` blocks. Extract one helper (`exitToRunResult(exit, start)` in `runner.ts`) and reuse.

### 6. Don't await independent disposes sequentially

Shutdown code was `await runner.dispose(); await trackerRuntime.dispose(); ...`. They're independent — use `Promise.all`. Likely pattern exists wherever the orchestrator does multi-resource shutdown.

### 7. Dispose runtimes in test cleanup

`runner.integration.test.ts` had ~12 `createRunner()` calls with no cleanup, leaking `ManagedRuntime` per test. Pattern that worked: wrap the constructor with a local `makeRunner()` helper that pushes into a `runners[]` array, then `afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.dispose())); })`. The orchestrator tests will have the same pattern — fix it as part of the migration.

### 8. Comments

Project rule (auto-memory): no WHAT comments, no narrating-the-change comments, only non-obvious WHY. The runner's first cut had `// Shouldn't happen — body's matchCauseEffect catches everything` referring to code that didn't even use `matchCauseEffect`. Misleading; deleted.

## Patterns that landed well

- **Module layout**: public types and main exported function at the top, private helpers below. `runner.ts` ends with `function newRunId()` and `function exitToRunResult()` as bottom-of-file private helpers.
- **`runtime.ts` sibling file** with `Layer.mergeAll(...)` + `ManagedRuntime.make` and a `type ...Runtime = ManagedRuntime.ManagedRuntime<...>`.
- **`Effect.tryPromise({ try: (signal) => ..., catch: ... })`** is the bridge from existing Promise-based code into the Effect world. The `signal` it provides is wired automatically to fiber interruption, replacing hand-rolled `AbortController` wiring.
- **`Effect.unsafeMakeSemaphore`** for in-process concurrency. Fine to use; it's not Layer-scoped but doesn't need to be.

## Project rules to honour upfront

In `CLAUDE.md` and auto-memory (`/Users/nhollas/.claude/projects/.../memory/MEMORY.md`):

- **No backcompat** — pre-launch project. Rename freely, change schemas in place.
- **kebab-case filenames**.
- **No `vi.mock`, full-shape `toEqual` assertions, minimal DI**.
- **No tests whose sole purpose is asserting log/warning emission**.
- **Logging paths must warn-and-continue, never throw**.
- **No real org/customer names — use `acme/widgets`**.
- **Module layout: public at top, private helpers at bottom**.

Also:

- Read `docs/coding-standards.md` and `docs/testing-standards.md` before writing code.
- For Effect API questions, read `repos/effect/AGENTS.md` and grep `repos/effect/packages/*`. Don't web-search Effect docs.
- Run `pnpm typecheck` and `pnpm test` before declaring done.
- pnpm only. macOS only.

## Suggested skills

- **`grill-with-docs`** — before Phase 6, stress-test the orchestrator's domain language against `docs/architecture.md` and any ADRs. The user values shared, precise terminology and that module is where it matters most.
- **`simplify`** — run after each phase to catch the same class of issues we cleaned up in the runner (Effect-language leakage, inline Effect blobs, redundant uninterruptible, etc.).

## Known follow-ups (not blocking)

- Runner's `inflightRuns` Map + `idleWaiters` array + inline `addObserver` registration could be replaced by Effect's `FiberMap` (keyed lookup, auto-removal, `awaitEmpty` built in). Skipped because none of the four migrated modules use it yet — adopting it should be a deliberate cross-cutting decision, not piecemeal. If the orchestrator naturally wants the same shape (tracking N inflight things by id with idle-wait semantics), that's the right moment to introduce `FiberMap` across all four.
- Runner test files still have `const { runId, result: done } = runner.enqueue(...)` — mechanical alias from the `done → result` rename. Easy follow-up, kept that diff focused.

## Branch state at handoff

- Branch: `feat/effect-trackers-pilot` (yes, grown beyond trackers — the user kept piling migrations onto it)
- Last commit: `c1f3c53` runner migration, pushed to `origin/feat/effect-trackers-pilot`
- Clean working tree
