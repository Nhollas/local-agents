# Workflow redesign — slice index

The redesign that turns `server/workflow/` into the workflow engine described in [ADR 0002](../adr/0002-workflow-engine-owns-agent-invocation.md). Source of truth for the target shape: [the prototype](../../workflow-redesign-prototype/src/data.ts). Per-slice behaviour checklist: [`semantic-cases.md`](semantic-cases.md).

Read [`../migration-standards.md`](../migration-standards.md) first. This is a rebuild, not a port — actively strip patterns the new design makes obsolete.

## Slices, in dependency order

| # | Slice | Type | Blocks |
|---|---|---|---|
| 1 | [Error taxonomy + prompt-scope types](slice-01-error-taxonomy.md) | AFK | 2, 3, 4 |
| 2 | [One-walk validator across all 4 template surfaces](slice-02-validator.md) | AFK | 7 |
| 3 | [AgentInvoker Tag + Live layer relocated into workflow/](slice-03-agent-invoker.md) | AFK | 5 |
| 4 | [WorkflowEventEmitter Tag + Queue-backed Live layer](slice-04-event-emitter.md) | AFK | 5 |
| 5 | [resolveBranch via runAgentTurn (delete branch-resolver.ts)](slice-05-resolve-branch.md) | AFK | 6 |
| 6 | [runSteps via runAgentTurn (delete step-runner.ts)](slice-06-run-steps.md) | AFK | 8 |
| 7 | [Pure renderChangeRequest (delete change-request-renderer.ts)](slice-07-render-change-request.md) | AFK | 8 |
| 8 | [event-consumer fiber + run-lifecycle per-run wiring](slice-08-event-consumer.md) | AFK | — |

## Prep already done

- Orchestrator tests for files being deleted have been removed (`step-runner.test.ts`, `branch-resolver.test.ts`, `change-request-renderer.test.ts`, `agent-logging.test.ts`).
- Their semantics are recorded in `semantic-cases.md` — each slice owns a section and must cover it with fresh tests at the new public boundary.
- Tests for files being *moved* (`agent-hooks.test.ts`, `run-log-file.test.ts`) stay put and move with their source files.

## Standing rules for every slice

- `pnpm typecheck && pnpm test` green before declaring done.
- No Zod, no `isRecord`, no `as` casts in newly-migrated code — use `effect/Schema`.
- No interface/type-alias wrappers around Effect-returning functions; expose `Effect.Effect<A, E, R>` directly.
- Observability lives on boundaries (engine entrypoints + event emission), not internal helpers.
- Engine names describe the domain, not Effect vocabulary — see "Lessons from the runner migration" in `migration-standards.md`.
