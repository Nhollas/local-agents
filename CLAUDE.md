## Project status

Pre-launch and unstable. There are no real users, no production data, and no compatibility guarantees. Don't propose migrations, backfills, dual-read shims, deprecation paths, or "additive" designs to preserve existing state — just make the breaking change. Drop old rows, rename freely, change schemas in place.

## Before writing code

- Read existing code in the area you're changing. Follow the patterns already there.
- Read `docs/coding-standards.md` and `docs/testing-standards.md`.
- For architecture context, see `docs/architecture.md`. For decision history, see `docs/adr/`.

## Vendored reference code under `repos/`

`repos/effect/` is the Effect-TS source vendored via `git subtree`. It is **read-only reference material** for you to learn from, not application code.

- Do NOT import from `repos/`. Application code imports from the `effect` package (and friends) in `node_modules`.
- Do NOT edit files under `repos/`. Changes there will be overwritten on the next subtree pull.
- DO read it freely. When you're unsure how an Effect API is meant to be used, look at how it's used inside `repos/effect/packages/*` and follow those patterns over web search or guessing.
- `repos/effect/AGENTS.md` is the Effect team's own guidance for agents writing Effect code — read it before writing non-trivial Effect code.

To refresh the vendored copy: `git subtree pull --prefix=repos/effect https://github.com/Effect-TS/effect.git main --squash`.

## Before considering work complete

- Run `pnpm typecheck` and `pnpm test` to verify nothing is broken.
- Use `pnpm test:coverage` as a diagnostic for spotting uncovered behaviour you care about, rather than treating the percentage as a target. Match the testing depth the repo already establishes.
- Leave the codebase better than you found it. Fix pre-existing issues you encounter, for example lint warnings, type errors, or code smells. Don't skip them just because they weren't yours.
