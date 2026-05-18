# Observability migration — plan

Sibling to `docs/orchestrator-effect-migration.md`. Read both. This one covers logging, spans, and metrics; that one covers the orchestrator phases. They interlock at Phases 4–6.

## Framing

There is no separate "observability migration pass" ahead of the orchestrator work. The original plan tried to swap the logger and unify the OTel pipeline up front, which forced a scaffold — a root `ManagedRuntime` plus a sync `log.*` facade — purely to bridge the non-Effect callers we hadn't migrated yet. That scaffold was bigger than the problem it solved and obscured the fact that none of the Effect benefits (structured context, spans, fiber refs) actually reach a `runFork`-and-forget call site.

The new direction: each module gets its observability story changed *during the phase that migrates it to Effect*. No cross-cutting logger swap, no global runtime smuggling, no transitional facade.

## Current state (2026-05-18)

Three logging systems running in parallel:

- **Pino** (`server/logger.ts`) — DI'd as `logger: Logger` into api, orchestrator, step-runner, run-lifecycle. Stays in place until the consuming module migrates.
- **Canonical log** (`server/canonical-log.ts`) — `AsyncLocalStorage` field bag, one wide event per run/request. Stripe-style. Stays as-is for now.
- **Effect logging** — implicit via `Logger.pretty` in each module's `runtime.ts`. Already in use inside migrated modules.

Three telemetry surfaces:

- **Hand-rolled OTel** — `server/telemetry/spans.ts` (`runRunSpan`/`runStepSpan`) for orchestrator; `otel.ts` boots the NodeSDK + Langfuse + Claude SDK auto-instrumentation.
- **Effect `Metric`** — trackers, code-hosts, http.
- **Effect `Effect.withSpan`** — only in `platform-client.ts`.

Scatter signals already visible (address when each phase touches the code):

- `code-hosts/github.ts` and `code-hosts/gitlab.ts` each hand-roll the same `changeRequests` `Metric.update` shape. Should be one code-host boundary, not duplicated per host.
- `orchestrator/agent-metrics.ts`, `agent-logging.ts`, `agent-hooks.ts` reach into `canonical-log.set()` from mid-flow. Internal sites mutating the wide-event bag.

## Model

Three layers. One source of truth per question. No overlap.

| Question | Home | Implementation |
|---|---|---|
| Did this run happen, what was the shape | Wide canonical event | Effect `FiberRef` annotations, flushed at boundary |
| Where did time go, what called what | OTel spans via Langfuse | `Effect.withSpan` on boundaries only |
| How is the system behaving in aggregate | OTel metrics | `Metric.*` on boundaries only |
| Ad-hoc dev-time stdout | Effect `Logger.pretty` (Effect code) / Pino (plain code) | `Effect.log*` inside Effect modules; `logger.*` everywhere else |

**Boundaries — the only places that get spans/metrics:**

- Per-run
- Per-step
- Per outbound HTTP call (already wired in `platform-client.ts`)
- Per agent SDK invocation (already wired via Claude instrumentation)
- Per inbound HTTP request (added when api migrates)

Nothing else. Mid-flow helpers get nothing without a written reason.

## Decisions

- **No cross-cutting logger swap.** Pino stays everywhere it is today. Migrated Effect modules use `Effect.log*` via their own `runtime.ts` (already the case). Each new phase removes its Pino dependency as part of the same change that converts it to Effect. ([feedback_logging_must_not_crash](.) still applies — `Effect.log*` cannot throw, so phase-level swaps are safe.)
- **No top-level root runtime yet.** Per-module `ManagedRuntime`s stay. They collapse in Phase 6 alongside the orchestrator, not before. There is nothing for a root runtime to do today that the per-module runtimes don't already do.
- **No sync log facade.** A `log.info(message, fields)` wrapper that calls `runFork` on every line throws away every reason to use Effect logging — no structured context, no span correlation, no fiber refs. If a non-Effect caller needs a logger, it gets Pino via DI; if it is Effect, it composes `Effect.logInfo` with `Effect.annotateLogs` directly.
- **Canonical log stays as-is** until orchestrator Phase 6. The `AsyncLocalStorage` bag still works for the plain-Promise callers that own it. Folding it into `FiberRef` annotations only makes sense once those callers are themselves Effect.
- **api migrates to `@effect/platform/HttpApi` as a single change, not piecemeal.** Surface is small (5–6 endpoints). Half-migration (Hono + Effect handlers) violates the no-partial-migrations rule from the orchestrator handoff.
- **No ADR.** Codified through the code in migrated modules and this document.

## Per-phase observability work

Done as part of each Effect-migration phase, not separately.

### Orchestrator Phase 4 — `step-runner.ts`

- Drop the `logger: Logger` parameter; use `Effect.logWarning` for the existing `gitRevParseSafe` / `setStepDiffAttributes` warn paths.
- `runStepSpan` → `Effect.withSpan`.
- `canonical-log.set` calls stay; bag is still owned by the plain-Promise caller above.

### Orchestrator Phase 5 — `run-lifecycle.ts`

- Drop `logger`.
- `runRunSpan` → `Effect.withSpan`.
- `canonical-log.run` is still invoked by orchestrator (Phase 6) — leave the bag plumbing alone until then.

### Orchestrator Phase 6 — `orchestrator.ts` + runtime consolidation

- Drop `logger`.
- `canonical-log.ts` deleted — `Effect.annotateLogs` on a per-run/per-tick `FiberRef`, flushed at the boundary.
- `server/telemetry/spans.ts` deleted.
- Per-module `ManagedRuntime`s collapse into a single root runtime on `server.ts`.

### Orchestrator Phase 7 — `agent-*`

- Drop the mid-flow `canonical-log.set` calls in `agent-metrics`/`agent-logging`/`agent-hooks`. Move that aggregation to the run/step boundary, which by Phase 6 owns the `FiberRef`.

### api migration (out-of-plan; do in one pass when started)

- `HttpApi` group per resource (runs, queue, stats, health, events).
- `Schema` validators replacing `zod` + `zValidator`.
- SSE: `HttpServerResponse.stream` + `Stream`.
- `ProblemDetailsError` → `HttpApiError` with a custom mapping.
- Canonical-log middleware → `HttpApiMiddleware` (or replace outright if canonical-log is already gone).
- Drop the `logger` DI from `createApi`.
- Tests rewritten against the handler, not the Hono app.

Deletes: `hono`, `@hono/zod-validator`, `zod` (from api). Adds: per-inbound-request boundary entry.

### Shared scatter (collapse opportunistically)

- `code-hosts/github.ts` + `gitlab.ts` `changeRequests` metric — collapse into the shared parent when next touching either file.

## What "done" looks like

- One logger API inside Effect code (`Effect.log*`). Pino removed only once no plain-Promise call site remains.
- One OTel pipeline (Effect spans/metrics/logs + Claude SDK instrumentation → NodeSDK → Langfuse).
- One runtime, created in `server.ts` at the end of Phase 6.
- `server/logger.ts`, `server/canonical-log.ts`, `server/telemetry/spans.ts` all deleted by the end of Phase 6.
- No `Metric.*` or `Effect.withSpan` call outside the five boundaries above.
- `zod` removed from api; remaining sites (`event-schema.ts`, `types/brands.ts`) tracked separately.

## Out of scope

- `server/db/` — not in any migration plan; address separately.
- `server/run-repository.ts` — same.
- `server/event-bus.ts`, `event-schema.ts` — same; still on zod.
- Replacing the `@opentelemetry/sdk-node` boot in `otel.ts` itself. When a root runtime arrives in Phase 6 it will integrate *with* it via `@effect/opentelemetry`, not replace it.
