## Commands

```bash
pnpm install              # install dependencies
pnpm dev                  # start orchestrator + dashboard concurrently
pnpm lint                 # biome check
pnpm lint:fix             # biome check --write
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest across all projects
```

## Structure

| Directory    | Purpose                                                          |
| ------------ | ---------------------------------------------------------------- |
| `server/`    | Orchestrator, queue, runner, code-host adapters, workflow engine |
| `dashboard/` | React + Vite dashboard UI with Tailwind                          |
| `docs/`      | Architecture, patterns, and coding standards                     |

## Project status

Pre-launch and unstable. There are no real users, no production data, and no compatibility guarantees. Don't propose migrations, backfills, dual-read shims, deprecation paths, or "additive" designs to preserve existing state — just make the breaking change. Drop old rows, rename freely, change schemas in place.

## Before writing code

- Read existing code in the area you're changing. Follow the patterns already there.
- Read `docs/coding-standards.md`.

## Before considering work complete

- Run `pnpm typecheck` and `pnpm test` to verify nothing is broken.
- Check test coverage before you start and again once you're done. You should keep coverage at the same level or improve it. Match the testing depth the repo already establishes.
- Leave the codebase better than you found it. Fix pre-existing issues you encounter, for example lint warnings, type errors, or code smells. Don't skip them just because they weren't yours.
