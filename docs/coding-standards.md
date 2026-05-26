# Coding Standards

Canonical rules for code in this repo.

---

## Naming

**Name a binding after the domain thing it holds, not its role in the surrounding expression.** If you reach for `stream`, `final`, `result`, `data`, `value`, `item` — stop and ask "what kind of thing does this hold?" That's the name. Carve-out: in genuinely generic plumbing the role *is* the domain — a fold's `(acc, x)` is fine.

---

## TypeScript

Goal: make invalid states unrepresentable; let the compiler verify assumptions.

### Always

- **No escape hatches.** No `any`, no unchecked `as`, no `@ts-ignore`. Use `unknown` and narrow.
- **Infer, don't duplicate.** Derive types from one source (`typeof`, `ReturnType`, `Schema.Type`). Annotate boundaries; infer interiors.
- **Exhaustive unions.** Every `switch` on a discriminant ends with `const _: never = x` in `default`.

### At boundaries (network, input, env, DB)

- **Parse, don't validate.** Untrusted input goes through a schema parser that returns the refined type. No `as User` on raw JSON.

### Domain modelling

- **Illegal states unrepresentable.** Use discriminated unions, not optional-field bags. If a comment says "only set when…", it's a union.

### Use sparingly

- **Generics:** only with a constraint and a relationship to preserve. No generic soup.
- **Conditional/mapped types:** library-level only. In app code, prefer a clearer domain model.
- **Type-level machinery (phantom types, etc.):** only when the guarantee is load-bearing.

### Decision rule

For any invariant: who enforces it? If the answer is "the developer, by remembering," move it into the type system.

### Module layout

Order top-to-bottom: imports → public types (including the module's main interface) → main implementation → private helpers and helper types. A reader skimming a file should see its public shape before its internals.

---

## Effect

- **Annotate every Effect-returning function.** Value, error, and service union are first-class contracts — don't let inference fall through. Inline callbacks passed to combinators stay inferred.
- **Inner helper Effects: inside the gen by default.** When a helper is bound to one `Effect.gen` body and closes over yielded services, define it inside the gen. Lift to module-level when it's reused, worth testing alone, or its dependencies aren't obvious from a short body.
