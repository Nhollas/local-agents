# `server/workflow` — Effect review

A walk through the workflow module to flag where Effect idioms are paying off, where the seams with Promise-land cost composition, and where small refactors would buy real safety. Each item: the smell, the concrete cost, the change, and a docs reference.

## Status

| § | Item | Status |
|---|------|--------|
| §1 | `agent-hooks.ts` — capture runtime instead of fresh `Effect.runSync` per tick | **Done** — `agent-hooks.ts` now takes a `Runtime` argument and uses `Runtime.runSync(runtime)`. |
| §2 | `run-log-file.ts` — Effect resource using `FileSystem` + `Scope` | **Done** — replaced with `makeRunLogWriter` returning an Effect; lifetime tied to the surrounding scope, writes serialised via `Effect.makeSemaphore`. |
| §3 | `agent-invoker.ts` — OTel + `AbortSignal` bridges | **Done** — `invoke` returns an `Effect` whose Scope owns the `AbortController`, propagation is read from `Tracer.currentOtelSpan`, and the layer-time `signal` param is gone. Cancellation now flows entirely through Effect interruption. |
| §4 | `run-agent-turn.ts` — fold-with-flags → `Stream.runHead` | **Done** — collapsed to `Stream.tap` + `Stream.filter` + `Stream.runHead`. |
| §5 | `run-steps.ts` — narrowing by `_tag` → `Effect.catchTag` | **Done** — three `Effect.catchTag` handlers, exhaustive. |

§6 (selective Effect use) and §7 (smaller observations) remain accurate; see them for the rationale on what's still left in plain TypeScript on purpose.

The historical write-ups for §1–§5 are kept below for context — they explain why each change was made, not what to do next.

---

## 1. `agent-hooks.ts` — ephemeral runtimes inside SDK callbacks

```ts
// agent-hooks.ts (before)
Effect.runSync(
  Metric.update(toolFailureTotal.pipe(Metric.tagged("tool", input.tool_name)), 1),
);
```

### Why it was a smell

`Effect.runSync` constructs a fresh `Runtime` every call. That runtime has no `Context`, no tags from the surrounding fiber, no shared tracer. The metric is recorded, but:

- Any `Metric.tagged` you add at the layer level (e.g. `Metric.tagged("run_id", runId)` from `runtime.ts`) is **not present** — the new runtime doesn't see it.
- If you later add a `MetricRegistry` to your live layer, this code keeps writing to the default registry and silently diverges.
- The tracer span in flight (the SDK is invoked inside `instrumentedQuery` which `Effect.withSpan`s) is not on the new runtime's fiber, so any future "record-on-current-span" logic would miss it.

### Better (now landed)

The workflow run captures the live `Runtime` once in `agent-invoker.ts` and threads it into `buildAgentHooks`, which calls `Runtime.runSync(runtime)`. Metric updates now run on the layer's runtime, with the layer's tags and tracer attached.

### Docs

- Runtime / `Runtime.runSync` on a captured runtime: <https://effect.website/docs/runtime/>
- Why default runtimes drop context: <https://effect.website/docs/runtime/#running-effects>

---

## 2. `run-log-file.ts` — Promise file IO with no Scope

```ts
// run-log-file.ts (before)
export function createRunLogWriter(logDir: string, id: RunId): RunLogWriter {
  const filePath = join(logDir, `${id}.log`);
  const ready = mkdir(logDir, { recursive: true }).then(() => {});
  let chain: Promise<void> = ready;
  return {
    append(block) {
      const next = chain.then(() => appendFile(filePath, formatBlock(block), "utf8"));
      chain = next.catch(() => {});
      return next;
    },
  };
}
```

### Why it was a smell

- `chain.catch(() => {})` swallowed every write failure silently.
- Interruption (`Fiber.interrupt`) left dangling `appendFile` work open until the OS reaped the FD; no `Scope` finalizer flushed or closed.
- Each call from Effect into the writer crossed into Promise-land — interruption stopped propagating *into* the file write.

### Better (now landed)

`makeRunLogWriter` is now an Effect using `FileSystem.FileSystem` and `Effect.makeSemaphore(1)` for write serialisation. Lifetime is tied to the surrounding `Scope` (via the workflow run's runtime); `mkdir` failures land in `Effect.logWarning` rather than being swallowed.

### Docs

- `Scope` and `acquireRelease`: <https://effect.website/docs/resource-management/scope/>
- `Effect.forkScoped`: <https://effect.website/docs/concurrency/fibers/#fork-scoped>
- `FileSystem` platform module: <https://effect.website/docs/platform/file-system/>

---

## 3. `agent-invoker.ts` — OTel propagation and AbortSignal bridges

```ts
// agent-invoker.ts (before)
const propagationCarrier: Record<string, string> = {};
propagation.inject(otelContext.active(), propagationCarrier);
// ...
abortController: abortControllerFromSignal(signal),
```

Where `signal: AbortSignal` was a layer-time constructor param plumbed in from the runner via `Effect.tryPromise`.

### Why it was a smell

Both pieces bridged Effect → SDK by hand. Effect has primitives for both, and the hand-rolled versions skipped Effect's tracing and interruption story:

1. **OTel context.** Reading from `@opentelemetry/api`'s active context happens to work *because* `@effect/opentelemetry/Tracer` activates the OTel context for the duration of an Effect span — but that's an implicit coupling. If `invoke` ever moved out of the synchronous slice of the Effect (e.g. behind a `Promise.then`), `otelContext.active()` would silently return an empty context.
2. **AbortSignal.** Cancellation flowed via a signal captured at layer-construction time. It worked because `Effect.tryPromise` provides an interruption-linked signal, but it was load-bearing on the runner's exact wiring — pulling the abort straight from Effect's scope is more obviously correct.

### Better (now landed)

`invoke` returns `Effect.Effect<AsyncIterable<AgentMessage>, never, Scope.Scope>`:

- The current Effect-managed OTel span is read via `Tracer.currentOtelSpan` and used to seed the W3C propagation carrier, so the traceparent we forward to the SDK subprocess is unambiguously the one Effect is tracking.
- An `AbortController` is created per invocation, and `Effect.addFinalizer` aborts it when the scope closes (normal completion, failure, or interruption). The layer-time `signal` parameter is gone.
- `run-agent-turn.ts` consumes the iterable via `Stream.unwrapScoped` so the scope is owned by the stream and closes when the stream finalises.

### Docs

- Effect + OpenTelemetry integration: <https://effect.website/docs/observability/telemetry/opentelemetry/>
- `Stream.unwrapScoped`: <https://effect.website/docs/stream/creating/#unwrapscoped>
- `Effect.addFinalizer`: <https://effect.website/docs/resource-management/scope/#adding-finalizers-to-a-scope>

---

## 4. `run-agent-turn.ts` — fold-with-flags vs early `Effect.fail`

```ts
// run-agent-turn.ts (before)
const outcome = yield* Stream.runFoldEffect(messages, initialState, (state, message) => {
  // ...accumulates state with flags `resultArrived`, `failureSubtype`...
});

if (outcome.failureSubtype !== undefined) return yield* Effect.fail(new AgentTurnError({ ... }));
if (!outcome.resultArrived || outcome.sessionId === undefined) return yield* Effect.fail(...);
```

### Why it was a smell

The stream already knew on `message.type === "result"` whether the turn was a success or a failure, but the fold walked to the end and then re-checked flags. That's the imperative shape ("set flag, branch later") wearing an Effect costume, and it made the state machine read as if multiple `result` messages were tolerated.

### Better (now landed)

```ts
const resultOption = yield* messages.pipe(
  Stream.tap((message) =>
    message.type === "assistant" ? events.emit(...) : Effect.void,
  ),
  Stream.filter((message): message is ResultMessage => message.type === "result"),
  Stream.runHead,
);
```

Tap assistant messages, take the first result, fail if missing or non-success. Same behaviour, half the state, no impossible flag combinations.

### Docs

- `Stream.runHead`, `Stream.takeUntil`: <https://effect.website/docs/stream/operations/>
- `Stream.tap`: <https://effect.website/docs/stream/operations/#tapping>

---

## 5. `run-steps.ts` — `error._tag === "AgentTurnError"` vs `Effect.catchTag`

```ts
// run-steps.ts (before)
if (error instanceof AgentTurnError && error.usage && error.sessionId) {
  yield* events.emit({ _tag: "StepResult", ... });
}
const stepError =
  error._tag === "AgentTurnError" && error.subtype === "error_max_structured_output_retries"
    ? new StructuredOutputDecodeError({ ... })
    : error;
```

### Why it was a smell

`error._tag === "..."` and `error instanceof AgentTurnError` were doing what `Effect.catchTag` was built for. The hand-written narrowing worked but wasn't exhaustive — adding a sixth `WorkflowExecutionError` wouldn't have failed the type checker here.

### Better (now landed)

Three `Effect.catchTag` handlers on `runAgentTurn(...)` — one per concrete error in `WorkflowExecutionError`. Adding a new tag is a compile error until it's handled.

### Docs

- `Effect.catchTag` / `catchTags`: <https://effect.website/docs/error-management/expected-errors/#catchtag>
- `Data.TaggedError` and exhaustiveness: <https://effect.website/docs/error-management/yieldable-errors/>

---

## 6. Selective Effect use — is it hurting you?

You asked. Short answer: **the boundary is what hurts, not the split.**

What's right:
- `parse.ts`, `render-prompt.ts`, `shell-expansion.ts` (the regex/marker parts), `render-change-request.ts` are mostly pure or tightly scoped. Wrapping them in `Effect.sync` would buy nothing.
- The IO modules (`loader.ts`, `resolve-branch.ts`, `run-steps.ts`, `run-agent-turn.ts`) are `Effect.Effect<…, error, requirements>` and compose. Good.

With §1–§3 landed, what previously cost you is now closed:
- `run-log-file.ts` participates in Scope and the logger layer.
- `agent-hooks.ts` reaches into Effect through the captured runtime.
- `agent-invoker.ts` no longer bridges OTel or AbortSignal by hand.

The pattern that pays: when a module does IO, fails, or composes other Effects, return an `Effect`. When it's a string-in-string-out function, leave it plain. Don't write thin `Effect.sync(() => render(...))` wrappers — they hide the function's purity.

---

## 7. Smaller observations

- **`Schema.decodeUnknown` with `onExcessProperty: "error"`** (parse.ts) — good. Strict by default catches workflow typos at load time. Keep it.
- **`Data.TaggedError`** (errors.ts) — correct usage. `_tag` is the discriminator; `Effect.catchTag` uses it.
- **`Effect.annotateLogs`** in `run-steps.ts` and `resolve-branch.ts` — good. These show up on every log line scoped to that effect.
- **`Effect.withSpan` in `run-agent-turn.ts`** — good. Now that the OTel bridge is unified (§3), span attributes propagate to the SDK subprocess via the W3C carrier.
- **`Effect.all(..., { concurrency: "unbounded" })`** in `shell-expansion.ts` — fine for now (workflow authors control prompts), but consider `concurrency: 4` if a prompt with many `!\`...\`` blocks becomes plausible.
- **`emptyStepUsage()`** factory returning a fresh object each call — fine. If you want compile-time immutability, `Schema.Class` would give you that and free decoders, but the current shape is honest and cheap.
- **`Layer.succeed(WorkflowEventEmitter, { emit })`** in `event-emitter.ts` — exactly the shape the Effect docs show. The orchestrator calling this with its own `Queue` is the right composition.

---

## Further reading

The four chapters of the Effect docs that cover ~80% of day-to-day use:

- **Services and Layers** — <https://effect.website/docs/requirements-management/services/>
- **Error management with tagged errors** — <https://effect.website/docs/error-management/expected-errors/>
- **Resource management with Scope** — <https://effect.website/docs/resource-management/scope/>
- **Runtime and ManagedRuntime** — <https://effect.website/docs/runtime/>

Vendored under `repos/effect/`:

- `repos/effect/AGENTS.md` — the Effect team's house rules for agents writing Effect code.
- `repos/effect/packages/platform/src/` — production-shaped reading. Mirror the `*.ts` + `internal/*.ts` split, the `Class`-based services, the `Layer.effect` / `Layer.scoped` constructors.
- `repos/effect/packages/cluster/` — full app patterns, not toy examples.
