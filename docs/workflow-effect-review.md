# `server/workflow` — Effect review

A walk through the workflow module to flag where Effect idioms are paying off, where the seams with Promise-land cost composition, and where small refactors would buy real safety. Each item: the smell, the concrete cost, the change, and a docs reference.

## TL;DR

The module is in good shape. Tagged errors, `Context.Tag` services, `Stream.fromAsyncIterable`, `Schema.decodeUnknown` are all used the way the Effect docs prescribe. The friction is concentrated in four places:

1. `agent-hooks.ts` calls `Effect.runSync(Metric.update(...))` inside SDK callbacks — an ephemeral runtime per metric tick.
2. `run-log-file.ts` is pure Promise + a manually chained `Promise<void>` to serialise writes — no `Scope`, no `FileSystem`, no cancellation hook.
3. `agent-invoker-live.ts` injects OTel context by hand and converts `AbortSignal` to `AbortController` by hand — both are things Effect's tracer + interruption can provide if the bridge is built once.
4. `run-steps.ts`/`run-agent-turn.ts` use ad-hoc state flags (`error._tag === "AgentTurnError"`, `resultArrived: false`) where `Effect.catchTag` and earlier `Effect.fail` would be exhaustive.

Nothing here is wrong enough to block work. They're the four refactors most likely to keep paying back.

---

## 1. `agent-hooks.ts` — ephemeral runtimes inside SDK callbacks

```ts
// agent-hooks.ts:248
Effect.runSync(
  Metric.update(toolFailureTotal.pipe(Metric.tagged("tool", input.tool_name)), 1),
);
```

### Why it's a smell

`Effect.runSync` constructs a fresh `Runtime` every call. That runtime has no `Context`, no tags from the surrounding fiber, no shared tracer. The metric is recorded, but:

- Any `Metric.tagged` you add at the layer level (e.g. `Metric.tagged("run_id", runId)` from `runtime.ts`) is **not present** — the new runtime doesn't see it.
- If you later add a `MetricRegistry` to your live layer, this code keeps writing to the default registry and silently diverges.
- The tracer span in flight (the SDK is invoked inside `instrumentedQuery` which `Effect.withSpan`s) is not on the new runtime's fiber, so any future "record-on-current-span" logic would miss it.

### Better

Build a `Runtime` once per workflow run (you already build one in `runtime.ts`) and capture it in the closure that the SDK calls back into:

```ts
// agent-invoker-live.ts
import { Runtime } from "effect";

export const claudeSdkAgentInvoker = (params: AgentInvokerLiveParams) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>(); // captures current Context
    return {
      invoke(opts) {
        return instrumentedQuery({
          // ...
          hooks: buildAgentHooks(runLogWriter, opts.onToolFailure, runtime),
        });
      },
    };
  });

// agent-hooks.ts
import { Runtime } from "effect";

export function buildAgentHooks(
  runLogWriter: RunLogWriter | undefined,
  onToolFailure: ((tool: string) => void) | undefined,
  runtime: Runtime.Runtime<never>,
) {
  const runSync = Runtime.runSync(runtime);
  // ...
  function record(input: HookInput) {
    if (input.hook_event_name === "PostToolUseFailure") {
      runSync(
        Metric.update(
          toolFailureTotal.pipe(Metric.tagged("tool", input.tool_name)),
          1,
        ),
      );
    }
  }
}
```

The hook is still synchronous from the SDK's perspective; the difference is that metric updates now run on **your** runtime, with **your** tags and tracer attached.

### Docs

- Runtime / `Runtime.runSync` on a captured runtime: <https://effect.website/docs/runtime/>
- Why default runtimes drop context: <https://effect.website/docs/runtime/#running-effects>

---

## 2. `run-log-file.ts` — Promise file IO with no Scope

```ts
// run-log-file.ts:19
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

### Why it's a smell

- `chain.catch(() => {})` swallows every write failure silently — no log line, no metric.
- If the workflow is interrupted (`Fiber.interrupt`), the dangling `appendFile` keeps the FD open until the OS reaps it. No `Scope` finalizer flushes or closes.
- The writer is a Promise factory used inside Effect code. Each call into it crosses the boundary back to Promise-land — interruption stops propagating *into* the file write.

### Better

`@effect/platform` already provides `FileSystem.FileSystem`. Build the writer as `Effect.acquireRelease` so it participates in `Scope`:

```ts
import { FileSystem } from "@effect/platform";
import { Effect, Queue } from "effect";

export const makeRunLogWriter = (logDir: string, id: RunId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const filePath = join(logDir, `${id}.log`);
    yield* fs.makeDirectory(logDir, { recursive: true });

    const queue = yield* Queue.unbounded<ToolBlock>();

    // Drain in a background fiber, interruptible with the parent scope.
    yield* Effect.forkScoped(
      Effect.forever(
        Queue.take(queue).pipe(
          Effect.flatMap((block) =>
            fs.writeFileString(filePath, formatBlock(block), { flag: "a" }),
          ),
          Effect.catchAll((err) =>
            Effect.logWarning(`run-log write failed: ${err}`),
          ),
        ),
      ),
    );

    return {
      append: (block: ToolBlock) => Queue.offer(queue, block),
    };
  });
```

Concrete payoff:

- `Effect.forkScoped` ties the drain fiber to the surrounding `Scope` — when the workflow is cancelled, the drain is interrupted, the queue is shut down, no orphan FDs.
- Errors land in `Effect.logWarning`, which honours your logger layer (so they show up in OTel logs, not just stderr).
- The hook layer still wants a synchronous `append`, so keep a thin Promise façade if needed — but the lifetime now lives in Effect.

### Docs

- `Scope` and `acquireRelease`: <https://effect.website/docs/resource-management/scope/>
- `Effect.forkScoped`: <https://effect.website/docs/concurrency/fibers/#fork-scoped>
- `FileSystem` platform module: <https://effect.website/docs/platform/file-system/>

---

## 3. `agent-invoker-live.ts` — manual OTel propagation, manual AbortSignal bridge

```ts
// agent-invoker-live.ts:38
const propagationCarrier: Record<string, string> = {};
propagation.inject(otelContext.active(), propagationCarrier);
const resolvedEnv = {
  ...baseEnv,
  ...(propagationCarrier["traceparent"] && { TRACEPARENT: propagationCarrier["traceparent"] }),
  ...(propagationCarrier["tracestate"] && { TRACESTATE: propagationCarrier["tracestate"] }),
};
```

```ts
// agent-invoker-live.ts:77
function abortControllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  return controller;
}
```

### Why it's a smell

Both pieces are bridging Effect → SDK by hand. Effect has primitives for both, and the hand-rolled versions skip Effect's tracing and interruption.

1. **OTel context.** You're reading from `@opentelemetry/api`'s active context. But Effect has its own tracer (`Effect.withSpan`, see `run-agent-turn.ts:133`). The two are not the same. If a future span is set via `Effect.withSpan` but no OTel exporter is wired into Effect's tracer, `propagation.inject` will pull a stale or empty context. The fix is to read the *Effect* span and pass `traceparent` from there — or unify them with `@effect/opentelemetry`'s `OtelTracerLive`.

2. **AbortSignal.** You're rebuilding cancellation semantics outside the Effect runtime. If `runAgentTurn` is interrupted via `Fiber.interrupt`, the `signal` here is whichever one the caller passed in, not Effect's interruption. You're not guaranteed to see the abort.

### Better

If `agent-invoker-live.ts` returns an `Effect` rather than a raw service, you can pull the abort signal from the running fiber:

```ts
export const claudeSdkAgentInvoker = (params: Omit<AgentInvokerLiveParams, "signal">) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<never>();
    return {
      invoke(opts) {
        return Effect.runtime<never>().pipe(
          Effect.flatMap(() =>
            // wrap the AsyncIterable so it interrupts when the fiber does
            Effect.asyncEffect<AgentMessage, AgentTurnError, never>(...),
          ),
        );
      },
    };
  });
```

Simpler interim move: wire `@effect/opentelemetry` (`NodeSdk.layer({ ... })`) so `Effect.withSpan` and the OTel SDK share the same context. Then `propagation.inject(otelContext.active(), ...)` reads what `Effect.withSpan` wrote, and the manual carrier construction becomes correct-by-construction.

### Docs

- Effect + OpenTelemetry integration: <https://effect.website/docs/observability/telemetry/opentelemetry/>
- `Effect.async` and interruption: <https://effect.website/docs/getting-started/creating-effects/#async>

---

## 4. `run-agent-turn.ts` — fold-with-flags vs early `Effect.fail`

```ts
// run-agent-turn.ts:69-118
const outcome = yield* Stream.runFoldEffect(messages, initialState, (state, message) => {
  // ...accumulates state with flags `resultArrived`, `failureSubtype`...
});

if (outcome.failureSubtype !== undefined) return yield* Effect.fail(new AgentTurnError({ ... }));
if (!outcome.resultArrived || outcome.sessionId === undefined) return yield* Effect.fail(...);
```

### Why it's a smell

You're inside a stream, and you already know on `message.type === "result"` whether it's success or failure. But you keep folding to the end, then re-check flags. That's the imperative shape ("set flag, branch later") wearing an Effect costume.

Concrete cost: the loop reads as if multiple `result` messages are tolerated (they're not — see `runFoldEffect` walking on after the result arrives). A future reader will assume the protocol allows that.

### Better

`Stream.runFoldEffect` lets you `Effect.fail` mid-fold, which terminates the stream. Or use `Stream.takeUntil` to short-circuit on result, then fold:

```ts
const resultMessage = yield* Stream.runHead(
  messages.pipe(
    Stream.tap((m) =>
      m.type === "assistant" ? events.emit(...) : Effect.void,
    ),
    Stream.filter((m): m is ResultMessage => m.type === "result"),
  ),
);

if (Option.isNone(resultMessage)) return yield* Effect.fail(...);
const result = resultMessage.value;
if (result.subtype !== "success") return yield* Effect.fail(new AgentTurnError({ ... }));
return { ... };
```

This collapses the state machine to: "tap assistant messages, take the first result, fail if missing or non-success." Same behaviour, half the state, no possible "what if `resultArrived === true && failureSubtype !== undefined`" combinations.

### Docs

- `Stream.runHead`, `Stream.takeUntil`: <https://effect.website/docs/stream/operations/>
- `Stream.tap`: <https://effect.website/docs/stream/operations/#tapping>

---

## 5. `run-steps.ts` — `error._tag === "AgentTurnError"` vs `Effect.catchTag`

```ts
// run-steps.ts:42
if (error instanceof AgentTurnError && error.usage && error.sessionId) {
  yield* events.emit({ _tag: "StepResult", ... });
}
const stepError =
  error._tag === "AgentTurnError" && error.subtype === "error_max_structured_output_retries"
    ? new StructuredOutputDecodeError({ ... })
    : error;
```

### Why it's a smell

`error._tag === "..."` and `error instanceof AgentTurnError` are doing what `Effect.catchTag` was built for. The hand-written narrowing works but isn't exhaustive — if a sixth `WorkflowExecutionError` is added tomorrow, this block doesn't tell you.

### Better

```ts
runAgentTurn(...).pipe(
  Effect.catchTag("AgentTurnError", (error) =>
    Effect.gen(function* () {
      if (error.usage && error.sessionId) {
        yield* events.emit({ _tag: "StepResult", stepName, sessionId: error.sessionId, usage: error.usage });
      }
      const mapped =
        error.subtype === "error_max_structured_output_retries"
          ? new StructuredOutputDecodeError({ message: error.message, context: "step" })
          : error;
      yield* events.emit({ _tag: "StepFailed", stepName, index, error: mapped, durationMs: ... });
      return yield* Effect.fail(mapped);
    }),
  ),
  Effect.catchTag("ShellExpansionError", (error) =>
    /* emit StepFailed and fail */
  ),
  Effect.catchTag("StructuredOutputDecodeError", (error) =>
    /* emit StepFailed and fail */
  ),
);
```

Now adding a new error tag is a compile error until you handle it. The runtime cost is identical; the maintenance cost is lower.

### Docs

- `Effect.catchTag` / `catchTags`: <https://effect.website/docs/error-management/expected-errors/#catchtag>
- `Data.TaggedError` and exhaustiveness: <https://effect.website/docs/error-management/yieldable-errors/>

---

## 6. Selective Effect use — is it hurting you?

You asked. Short answer: **the boundary is what hurts, not the split.**

What's right:
- `parse.ts`, `render-prompt.ts`, `shell-expansion.ts` (the regex/marker parts), `render-change-request.ts` are mostly pure or tightly scoped. Wrapping them in `Effect.sync` would buy nothing.
- The IO modules (`loader.ts`, `resolve-branch.ts`, `run-steps.ts`, `run-agent-turn.ts`) are `Effect.Effect<…, error, requirements>` and compose. Good.

What's costing you:
- **`run-log-file.ts`** — see §2. This IO module skips Effect, so its lifetime is unmanaged and it can't share the `Logger` or `FileSystem`.
- **`agent-hooks.ts`** — see §1. Sits in Promise-land but reaches into Effect for `Metric.update`, which means each reach pays the cost of building a runtime.
- **`agent-invoker-live.ts`** — see §3. Bridges Promise (SDK) to Effect (the rest of workflow), but does it manually for both directions (env injection, abort signal).

The pattern that pays: when a module does IO, fails, or composes other Effects, return an `Effect`. When it's a string-in-string-out function, leave it plain. Don't write thin `Effect.sync(() => render(...))` wrappers — they hide the function's purity.

---

## 7. Smaller observations

- **`Schema.decodeUnknown` with `onExcessProperty: "error"`** (parse.ts) — good. Strict by default catches workflow typos at load time. Keep it.
- **`Data.TaggedError`** (errors.ts) — correct usage. `_tag` is the discriminator; `Effect.catchTag` uses it.
- **`Effect.annotateLogs`** in `run-steps.ts:128` and `resolve-branch.ts:83` — good. These show up on every log line scoped to that effect.
- **`Effect.withSpan` in `run-agent-turn.ts:133`** — good. Pairs with the OTel work from §3; once the tracer layer is unified, span attributes will propagate to the SDK.
- **`Effect.all(..., { concurrency: "unbounded" })`** in `shell-expansion.ts:53` — fine for now (workflow authors control prompts), but consider `concurrency: 4` if a prompt with many `!\`...\`` blocks becomes plausible.
- **`emptyStepUsage()`** factory returning a fresh object each call — fine. If you want compile-time immutability, `Schema.Class` would give you that and free decoders, but the current shape is honest and cheap.
- **`Layer.succeed(WorkflowEventEmitter, { emit })`** in `event-emitter-live.ts` — exactly the shape the Effect docs show. The orchestrator calling this with its own `Queue` is the right composition.

---

## Recommended order

If you want to attack this incrementally:

1. **§4 (run-agent-turn fold)** — purely local, no API change, immediate readability win.
2. **§5 (run-steps catchTag)** — local refactor, gives you exhaustiveness checking.
3. **§1 (agent-hooks runtime capture)** — small API change to `buildAgentHooks` and `claudeSdkAgentInvoker`. Pays back the moment you add tagged metrics.
4. **§2 (run-log-file as Effect resource)** — bigger refactor, but unlocks cancellation propagation through the full workflow.
5. **§3 (OTel + AbortSignal bridge)** — wait until you wire `@effect/opentelemetry`; doing this without that integration is half a fix.

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
