## Project status

Pre-launch and unstable. There are no real users, no production data, and no compatibility guarantees. Don't propose migrations, backfills, dual-read shims, deprecation paths, or "additive" designs to preserve existing state — just make the breaking change. Drop old rows, rename freely, change schemas in place.

## Before writing code

- Read existing code in the area you're changing. Follow the patterns already there.
- Read `docs/coding-standards.md` and `docs/testing-standards.md`.
- For architecture context, see `docs/architecture.md`. For decision history, see `docs/adr/`.

## Before considering work complete

- Run `pnpm typecheck` and `pnpm test` to verify nothing is broken.
- Use `pnpm test:coverage` as a diagnostic for spotting uncovered behaviour you care about, rather than treating the percentage as a target. Match the testing depth the repo already establishes.
- Leave the codebase better than you found it. Fix pre-existing issues you encounter, for example lint warnings, type errors, or code smells. Don't skip them just because they weren't yours.
