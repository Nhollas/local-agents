Pre-launch, no users, no compatibility guarantees. Make breaking changes freely.

Follow @docs/coding-standards.md and @docs/testing-standards.md.

## Vendored reference code under `repos/`

`repos/effect/` is the Effect-TS source vendored via `git subtree`. It is **read-only reference material**, not application code.

- Do NOT import from or edit files under `repos/`. Application code imports from the `effect` package in `node_modules`.
- DO read `repos/effect/packages/*/src/` when unsure how an Effect API works — follow those patterns.
