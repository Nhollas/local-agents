# Effect migration — status

Snapshot of the `server/` Effect migration on `feat/effect-trackers-pilot` as of 2026-05-18. Read alongside `docs/orchestrator-effect-migration.md` (the original phased plan).

Not a 1:1 port. Each migrated module was actively simplified: Zod → `effect/Schema`, ceremony wrappers deleted, `isRecord`/`as` casts stripped, hand-rolled HTTP/fs/child-process replaced with `@effect/platform` primitives.

## Module map

| Module | Status | Notes |
|---|---|---|
| `server/trackers/` | ✅ Done | First migration. Owns `runtime.ts`. |
| `server/code-hosts/` | ✅ Done | GitHub + GitLab on shared `platformHttpClient`. |
| `server/workflow/` | ✅ Done | Owns `runtime.ts`. |
| `server/runner/` | ✅ Done | Owns `runtime.ts`. Rebuild lessons captured in handoff doc. |
| `server/http/` | ✅ Done (extracted) | New shared module — `platform-client.ts` consumed by all three remote clients. |
| `server/config/` | ✅ Done | Restructured: `app-config.ts` exposes `Effect`-shaped config; per-kind secrets inlined; `env.ts` + `schema.ts` split out. |
| `server/orchestrator/` | 🟡 In progress | Phases 1–3 landed + a Phase-2 leaf. See breakdown below. |
| `server/api/` | ⛔ Not started | Still hand-rolled Fastify-style handlers; no Effect. |
| `server/db/` | ⛔ Not started | Plain better-sqlite3; not in original plan. |
| `server/run-repository.ts` | ⛔ Not started | Promise-based; consumed by orchestrator. |
| `server/event-bus.ts`, `event-schema.ts` | ⛔ Not touched | Still on Zod. |
| `server/canonical-log.ts`, `logger.ts` | ⛔ Not touched | Plain modules. |
| `server/telemetry/` | ⛔ Not touched | `otel.ts` imports `effect` but module is otherwise OTel-native. Marked dead-code-walking in project memory. |
| `server/test-support/` | 🟡 Partial | `code-host-stub.ts`, `tracker-stub.ts` are Effect-aware; rest is plain. |
| `server/server.ts` | 🟡 Boots runtimes | Wires per-module `ManagedRuntime`s + disposes them. Not yet collapsed to a single runtime (Phase 6 endgame). |

## Orchestrator phase progress

Phase plan from `docs/orchestrator-effect-migration.md`:

| Phase | Scope | Status |
|---|---|---|
| 1 — Foundation | `orchestrator/runtime.ts` scaffold + wire dispose | ✅ `34f353809` |
| 2 — Leaf helpers | `parse-shortstat`, `change-request-renderer`, `branch-resolver`, `clock`, `run-log-file` | 🟡 Partial — only `branch-resolver` migrated (`d61976497`). Others remain plain; under the plan's "or left alone because no runtime boundary" carve-out, but worth a deliberate sweep before declaring Phase 2 done. |
| 3 — `workspace.ts` | filesystem ops via `@effect/platform-node` | ✅ Landed inside `09869b3c1` (commit title is misleading — workspace was rewritten in the same change). Uses `Command`, `CommandExecutor`, `FileSystem`, `Stream`. |
| 4 — `step-runner.ts` | step execution | ⛔ Not started. Still uses `node:child_process` + `promisify`. |
| 5 — `run-lifecycle.ts` | per-run dispatch / finalize | ⛔ Not started. Imports `Cause`/`Exit`/`Option` only to consume runner's Effect return shape. |
| 6 — `orchestrator.ts` + runtime consolidation | tick loop, scheduling, recovery; collapse per-module runtimes | ⛔ Not started. Still 5 sibling `runtime.ts` files. |
| 7 — `agent-*` | `agent-env`, `agent-hooks`, `agent-invoker`, `agent-logging`, `agent-metrics` | ⛔ Not started. All plain. |

### Orchestrator file detail

```
parse-shortstat.ts          15  plain        (leaf, pure)
clock.ts                     9  plain        (leaf, trivial)
runtime.ts                  17  effect       ✅ Phase 1
change-request-renderer.ts  23  plain        Phase 2 — left alone (pure render)
run-log-file.ts             77  plain        Phase 2 — still on fs/promises
branch-resolver.ts          —   effect       ✅ Phase 2
workspace.ts               371  effect       ✅ Phase 3
step-runner.ts             302  plain        ⛔ Phase 4
orchestrator.ts            400  plain        ⛔ Phase 6
run-lifecycle.ts           460  partial      ⛔ Phase 5 (consumes Effect types only)
agent-env.ts                 —  plain        ⛔ Phase 7
agent-hooks.ts               —  plain        ⛔ Phase 7
agent-invoker.ts             —  plain        ⛔ Phase 7
agent-logging.ts             —  plain        ⛔ Phase 7
agent-metrics.ts             —  plain        ⛔ Phase 7
```

## Runtimes

Five `ManagedRuntime`s live today, all transitional per the plan:

- `server/trackers/runtime.ts`
- `server/code-hosts/runtime.ts`
- `server/workflow/runtime.ts`
- `server/runner/runtime.ts`
- `server/orchestrator/runtime.ts`

Endgame (Phase 6): collapse into one runtime at the top of `server.ts` and delete the per-module files. Don't grow these in the meantime.

## Out-of-plan work that landed on the branch

- **`server/http/platform-client.ts`** — extracted from `gitlab-client` and adopted by github + jira. Wasn't in the original plan but unblocked the three-client convergence.
- **`server/config/` restructure** — split `app-config.ts` and inlined per-kind secrets. Effect-shaped, consumed via `Layer`.
- **Zod removal** — partially complete. Still present in: `server/event-schema.ts`, `server/types/brands.ts`, `server/api/api.ts`, `server/api/problem-details.test.ts`.

## What's left, ranked

1. Phase 4 — `step-runner.ts` (next per plan, depends on already-migrated workflow + workspace).
2. Phase 5 — `run-lifecycle.ts`.
3. Phase 6 — `orchestrator.ts` + collapse the five runtimes into one.
4. Phase 7 — `agent-*` files.
5. Sweep Phase 2 leaves: decide per file whether to migrate or formally close out.
6. Out-of-plan but adjacent: `api/`, `db/`, `run-repository.ts`, remaining Zod sites, `event-bus`/`event-schema`. Not part of the orchestrator plan — separate decision.
