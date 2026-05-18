# Migration standards

Standing rules and lessons for migrating a backend module to Effect. Read this before starting any migration phase. Plan documents come and go; this file holds the framing and patterns that survive.

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
- **No partial migrations.** Once a module is in, it's all in. When the last tracker landed, the bridging junk got deleted: interface collapsed, `Effect.runPromise` pushed up to `server.ts`. Aim for that same endgame in every phase.
- **Per-module `runtime.ts` is transitional, not the destination.** End state is one runtime at the top of the process. Every phase plan should be moving toward collapsing runtimes, not multiplying them — when the last module migrates, that's the moment to consolidate.
- **Reach for the right `@effect/*` sub-package; consult `repos/effect`.** `@effect/platform`'s `Command`, `FileSystem`, `HttpClient` etc. exist — use them instead of re-deriving Promise/child_process/fs logic. When unsure, read `repos/effect/packages/*` and `repos/effect/AGENTS.md`.

## Definition of done per phase

Every phase ends with the migrated code (a) free of Zod / `isRecord` / `as` casts / ceremony wrappers, (b) exposing real `Effect.Effect<A, E, R>` signatures rather than hand-written interfaces, and (c) leaning on `@effect/platform` primitives where they apply. If a phase ships without that audit, it isn't done.

`pnpm typecheck && pnpm test` must be green at the end of every phase.

## HTTP

If the module being migrated doesn't do HTTP directly — for example, it calls into `trackers/` or `code-hosts/`, which are already migrated — you should not be writing much Effect HTTP DSL. Those modules already speak Effect-flavoured APIs. The scary `req.pipe(HttpClientRequest.setHeader(...), ...)` style (see `server/code-hosts/github-client.ts`) belongs only in modules that talk to real HTTP themselves.

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

Shutdown code was `await runner.dispose(); await trackerRuntime.dispose(); ...`. They're independent — use `Promise.all`. Apply the same wherever multi-resource shutdown happens.

### 7. Dispose runtimes in test cleanup

`runner.integration.test.ts` had ~12 `createRunner()` calls with no cleanup, leaking `ManagedRuntime` per test. Pattern that worked: wrap the constructor with a local `makeRunner()` helper that pushes into a `runners[]` array, then `afterEach(async () => { await Promise.all(runners.splice(0).map(r => r.dispose())); })`. Any module with multiple per-test runtime instances will have the same shape — fix it as part of the migration.

### 8. Comments

Project rule (auto-memory): no WHAT comments, no narrating-the-change comments, only non-obvious WHY. The runner's first cut had `// Shouldn't happen — body's matchCauseEffect catches everything` referring to code that didn't even use `matchCauseEffect`. Misleading; deleted.

## Patterns that landed well

- **Module layout**: public types and main exported function at the top, private helpers below. `runner.ts` ends with `function newRunId()` and `function exitToRunResult()` as bottom-of-file private helpers.
- **`runtime.ts` sibling file** with `Layer.mergeAll(...)` + `ManagedRuntime.make` and a `type ...Runtime = ManagedRuntime.ManagedRuntime<...>`. Transitional only — the destination is a single runtime at the top of the process.
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

- **`grill-with-docs`** — before migrating a module that owns important domain language, stress-test that vocabulary against `docs/architecture.md`, `CONTEXT.md`, and any relevant ADRs. The user values shared, precise terminology and pays attention to it.
- **`simplify`** — run after each phase to catch the same class of issues we cleaned up in the runner (Effect-language leakage, inline Effect blobs, redundant uninterruptible, etc.).
