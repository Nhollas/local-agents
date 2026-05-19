# Coding Standards

Canonical rules for code in this repo.

## Sections

- [Naming](#naming)
- [TypeScript](#typescript)
- [Effect](#effect)

---

## Naming

**Name a binding after the domain thing it holds, not its role in the surrounding expression.**

If you reach for `stream`, `final`, `result`, `next`, `incoming`, `existing`, `temp`, `data`, `value`, `item`, `obj` — stop and ask "what kind of thing does this hold?" That's the name. The structural role (it's a Stream, it's the last value of a fold) is already encoded by the type and by the binding's position in the code; restating it adds zero information.

```ts
// Avoid — role names
const stream = Stream.fromAsyncIterable(invoker.invoke(opts));
const final = yield* Stream.runFoldEffect(stream, initial, step);

// Prefer — domain names
const messages = Stream.fromAsyncIterable(invoker.invoke(opts));
const outcome = yield* Stream.runFoldEffect(messages, initial, step);
```

**Carve-out: in genuinely generic plumbing, the role *is* the domain.** A fold step's `(acc, x)`, a `map` callback's `(item)` in a one-line lambda, a higher-order utility's `state` parameter — these earn their role names because the function has no domain to refer to. The distinction: ask whether the surrounding code is doing *business work* (name the noun) or *generic plumbing* (role name is fine).

---

## TypeScript

Goal: make invalid states unrepresentable; let the compiler verify assumptions.

### Always

- **No escape hatches.** No `any`, no unchecked `as`, no `@ts-ignore`. Use `unknown` and narrow.
- **Infer, don't duplicate.** Derive types from one source (`typeof`, `ReturnType`, `z.infer`). Annotate boundaries; infer interiors.
- **Exhaustive unions.** Every `switch` on a discriminant ends with `const _: never = x` in `default`.

### At boundaries (network, input, env, DB)

- **Parse, don't validate.** Untrusted input goes through a schema parser that returns the refined type. No `as User` on raw JSON.
- **Brand meaningful primitives.** `UserId`, `Email`, `Meters` — distinct from `string`/`number`. Construction goes through the parser.

### Domain modeling

- **Illegal states unrepresentable.** Use discriminated unions, not optional-field bags. If a comment says "only set when…", it's a union.
- **Errors as values.** Expected failures → `Result<T, E>` or tagged union in the return type. Throw only for unrecoverable invariant violations.

### Use sparingly

- **Generics:** only with a constraint and a relationship to preserve. No generic soup.
- **Conditional/mapped types:** library-level only. In app code, prefer a clearer domain model.
- **Type-level machinery (phantom types, etc.):** only when the guarantee is load-bearing.

### Decision rule

For any invariant: who enforces it? If the answer is "the developer, by remembering," move it into the type system.

### Module layout

Order top-to-bottom: imports → public types (including the module's main interface) → main implementation → private helpers and helper types. A reader skimming a file should see its public shape before its internals. Don't bury the interface below helper functions.

---

## Effect

### Always annotate Effect-returning functions

Every named function (declared with `const name = ...` or `function name`) whose return type is an `Effect` declares the return type explicitly — the value, error, and service union are first-class contracts. Don't let inference fall through; readers should see what the function requires and can fail with at the signature, not by tracing the body. This applies to both module-level functions and inner helpers defined inside a gen body.

Inline callbacks passed to combinators (`Effect.catchAll(err => ...)`, the step callback in `Stream.runFoldEffect`, etc.) are consumed at a known expected type and stay inferred.

```ts
// Required
export const runAgentTurn = (
  input: AgentTurnInput,
): Effect.Effect<
  AgentTurnOutcome,
  WorkflowExecutionError,
  AgentInvoker | WorkflowEventEmitter | CommandExecutor.CommandExecutor | FileSystem.FileSystem
> => Effect.gen(function* () { ... });
```

This is the one place the general "annotate boundaries, infer interiors" rule from the TypeScript section is overridden: every Effect-returning function is treated as a boundary.

### Inner helper Effects: inside the gen by default

When a helper Effect is bound to one `Effect.gen` body — used only inside it, closing over services or scoped values yielded in that gen — define it *inside* the gen. The closure removes parameter threading, and the pattern matches Effect's own library code (see `repos/effect/packages/effect/src/internal/rateLimiter.ts`, where `refill` and `take` are defined inside the gen and close over yielded semaphores).

```ts
Effect.gen(function* () {
  const events = yield* WorkflowEventEmitter;

  const failStep = (stepName: string, error: WorkflowExecutionError) =>
    Effect.gen(function* () {
      yield* events.emit({ _tag: "StepFailed", stepName, error });
      return yield* Effect.fail(error);
    });

  ...
});
```

Lift the helper to module-level when any of these apply: it's reused by other gens, it's worth testing in isolation, or its dependencies aren't obvious from a short body. Then take the service as a parameter.