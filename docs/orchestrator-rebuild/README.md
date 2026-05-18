# Orchestrator rebuild — slice index

The rebuild that takes `server/orchestrator/` off Promise glue and onto Effect, finishes the migration of the last big domain module, and collapses the five per-module `runtime.ts` files into a single top-level `ManagedRuntime`.

**Required reading for every slice (in order):**

1. The slice doc itself.
2. [`../migration-standards.md`](../migration-standards.md) — the rebuild philosophy and runner-migration lessons.
3. [`../../orchestrator-effect-prototype/NOTES.md`](../../orchestrator-effect-prototype/NOTES.md) — the verdict that locks the v4 phase-walker shape.
4. [`../../orchestrator-effect-prototype/src/variants/v4-composed.ts`](../../orchestrator-effect-prototype/src/variants/v4-composed.ts) — the composition pattern the rebuild follows.

**Reference, if needed:**

- The existing `server/orchestrator/run-lifecycle.ts` — the imperative Promise-glue version being replaced. Read to extract behaviour, not patterns.
- The existing `orchestrator.*.integration.test.ts` files — these survive the rebuild and are the semantic spec.

## What's already done

These files don't need rewriting — they're already Effect, just consumed via Promise wrappers in `run-lifecycle.ts`:

- `workspace.ts` — uses `@effect/platform`'s `Command` + `FileSystem`, returns `Effect<A, E, R>`.
- `event-consumer.ts` — `Stream.fromQueue`, returns `Effect<void>`.
- `agent-env.ts`, `parse-shortstat.ts`, `clock.ts` — pure helpers.

Most of the migration is **deleting the Promise glue around them**, not rewriting them.

## Slices, in dependency order

| # | Slice | Type | Blocks |
|---|---|---|---|
| 1 | [Phase types + walker scaffold](slice-01-phase-scaffold.md) | AFK | 2, 3, 4 |
| 2 | [Pre-engine phases as files (workspace / ensure-branch / skills / setup)](slice-02-pre-engine-phases.md) | AFK | 5 |
| 3 | [Engine phases as files (branch-resolver / steps)](slice-03-engine-phases.md) | AFK | 5 |
| 4 | [Finalize phases as files (push / change-request / tracker)](slice-04-finalize-phases.md) | AFK | 5 |
| 5 | [Walker assembly + `run-lifecycle` rebuild](slice-05-walker-assembly.md) | AFK | 6 |
| 6 | [`orchestrator.ts` surface goes Effect](slice-06-orchestrator-effect.md) | AFK | 7 |
| 7 | [Runtime consolidation — one runtime at the top](slice-07-runtime-consolidation.md) | AFK | — |

## Handoff — when your slice is done

All slices land on the same branch. There is **no PR per slice**.

- Run `pnpm typecheck && pnpm test`. Both must be green — including the orchestrator integration tests.
- **Stop. Do not `git add`, `git commit`, or `git push`.** The user reviews the working-tree diff and decides when to commit.
- Report what you changed in your final message: which files were created / modified / deleted, and any deviation from the slice doc you had to make (and why).

## Standing rules for every slice

- `pnpm typecheck && pnpm test` green before declaring done — including `orchestrator.*.integration.test.ts`.
- No Zod, no `isRecord`, no `as` casts in newly-migrated code — use `effect/Schema`.
- No interface/type-alias wrappers around Effect-returning functions; expose `Effect.Effect<A, E, R>` directly.
- Observability lives on the walker boundary via `withObservability` — never inside phase bodies. This is the whole point of choosing v4.
- Engine names describe the domain, not Effect vocabulary — see "Lessons from the runner migration" in `migration-standards.md`.
- Per-module `runtime.ts` is transitional. The destination is a single runtime in `server.ts`. Slice 7 collapses them; earlier slices must not multiply them.
