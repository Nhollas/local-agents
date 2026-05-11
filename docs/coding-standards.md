# Coding Standards

Canonical rules for code in this repo.

## Sections

- [TypeScript](#typescript)

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