# Local Agents

Local autonomous agents powered by Claude Agent SDK — a polling orchestrator that dispatches Claude Code agents to work on GitHub issues and PRs.

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
| `core/`      | Orchestrator, queue, runner, code-host adapters, workflow engine |
| `dashboard/` | React + Vite dashboard UI with Tailwind                          |
| `docs/`      | Architecture and pattern documentation                           |

## Before writing code

- Read existing code in the area you're changing. Follow the patterns already there.
- Read existing tests before writing new ones. The test helpers ARE the conventions.

## Before considering work complete

- Run `pnpm lint` and `pnpm typecheck` — they catch style and correctness issues that don't need to be documented.
- Leave the codebase better than you found it. Fix pre-existing issues you encounter — for example lint warnings, type errors, or code smells — don't skip them just because they weren't yours.
