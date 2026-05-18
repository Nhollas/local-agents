# Slice 1 — Phase types + walker scaffold

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), [`../../orchestrator-effect-prototype/NOTES.md`](../../orchestrator-effect-prototype/NOTES.md), and [`../../orchestrator-effect-prototype/src/variants/v4-composed.ts`](../../orchestrator-effect-prototype/src/variants/v4-composed.ts). No existing tests are deleted.

## What to build

The foundation types and the `withObservability` decorator the walker (slice 5) and every phase (slices 2–4) consume. No behaviour change in this slice — `run-lifecycle.ts` is untouched.

Land in `server/orchestrator/`:

- `phases/types.ts` — `PhaseName`, `PHASE_ORDER`, `RunState`, `RunResult`, `Phase` (signature only — no implementations yet).
- `phases/errors.ts` — `PhaseFailure` tagged error wrapping a typed `cause` union.
- `phases/with-observability.ts` — the per-phase `tap` / `tapError` decorator factory. Initially writes to a `Ref<RunState>` (for partial-state-on-failure recovery) and emits a `system` event via the run context for trace breadcrumbs. Canonical-log writes and span instrumentation get layered in alongside slice 5; this scaffold provides the seam.

Locked shapes — copy verbatim:

```ts
// phases/types.ts
export type PhaseName =
  | "workspace"
  | "branch_resolver"
  | "ensure_branch"
  | "skills"
  | "setup"
  | "steps"
  | "push"
  | "change_request"
  | "tracker";

export const PHASE_ORDER: readonly PhaseName[] = [
  "workspace", "branch_resolver", "ensure_branch", "skills",
  "setup", "steps", "push", "change_request", "tracker",
];

export type RunState = {
  wsPath?: string;
  branch?: string;
  workspaceEnv?: Record<string, string>;
  outputs?: Record<string, unknown>;
  prUrl?: string;
};

export type RunResult =
  | { status: "completed"; state: RunState }
  | { status: "failed"; phase: PhaseName; cause: PhaseFailureCause; state: RunState };

export type Phase = (s: RunState) => Effect.Effect<RunState, PhaseFailure, PhaseDeps>;
```

```ts
// phases/errors.ts
import { Data } from "effect";
import type { PlatformError } from "@effect/platform/Error";
import type { WorkflowExecutionError } from "../../workflow/errors.ts";
import type { WorkspaceCommandError } from "../workspace.ts";
// (extend the cause union as phase slices land — code-host + tracker errors will join later slices)

export type PhaseFailureCause =
  | WorkspaceCommandError
  | WorkflowExecutionError
  | PlatformError
  | { _tag: "PhaseSetupError"; message: string };

export class PhaseFailure extends Data.TaggedError("PhaseFailure")<{
  phase: PhaseName;
  cause: PhaseFailureCause;
}> {}
```

```ts
// phases/with-observability.ts
type ObserveDeps = {
  lastState: Ref.Ref<RunState>;
  // event-emission seam — wired up in slice 5; in this slice, accept a no-op fn
  recordBreadcrumb: (line: string) => Effect.Effect<void>;
};

export const withObservability =
  (deps: ObserveDeps) =>
  (name: PhaseName, phase: Phase): Phase =>
  (s) =>
    phase(s).pipe(
      Effect.tap((next) => Ref.set(deps.lastState, next)),
      Effect.tap(() => deps.recordBreadcrumb(`phase ${name} ok`)),
      Effect.tapError((err) => deps.recordBreadcrumb(`phase ${name} failed: ${describe(err)}`)),
    );
```

`PhaseDeps` (the `R` channel of `Phase`) is a placeholder union of service tags this slice doesn't need to enumerate — each phase slice adds the services it actually consumes. The compiler will surface the full union when the walker is assembled in slice 5.

## Acceptance criteria

- [ ] `phases/types.ts`, `phases/errors.ts`, `phases/with-observability.ts` exist with the shapes above.
- [ ] No phase implementations yet. No call sites changed. `run-lifecycle.ts` untouched.
- [ ] `PhaseFailure` is a `Data.TaggedError` — no plain-object error shapes.
- [ ] No `as` casts, no Zod, no interface wrappers (see `migration-standards.md`).
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

None — can start immediately.
