# Slice 2 — Pre-engine phases as files

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), and [`../../orchestrator-effect-prototype/src/variants/v4-composed.ts`](../../orchestrator-effect-prototype/src/variants/v4-composed.ts). Skim the relevant blocks of the existing `server/orchestrator/run-lifecycle.ts` (the `try` block from `createWorkspace` through `runRepoSetup`) for the behaviour to preserve.

## What to build

Lift the four pre-engine phases out of `run-lifecycle.ts` into individual files, each conforming to the `Phase` signature from slice 1. These phases call into `workspace.ts` (already Effect) — the migration is mostly relocation + adopting the `Phase` shape + folding native errors into `PhaseFailure`.

Land in `server/orchestrator/phases/`:

- `workspace.ts` — wraps `createWorkspace(...)`. Sets `runRepo.setRunWorkspaceDir` as a tap (side effect on success). Reads `issue`, `cloneUrl`, `workspaceRoot`, `runId` from a `PhaseInputs` service tag (see below).
- `ensure-branch.ts` — wraps `ensureBranch(wsPath, branch)`. Requires `state.branch` to be set (slice 3's branch-resolver phase populates it).
- `skills.ts` — wraps `installSkills(...)`. On success, sets `canonicalLog` aggregates (`skills_installed`, `skills_skipped`) and emits a `system` event if any skills moved.
- `setup.ts` — wraps `resolveWorkspaceEnvironment(...)` then `runRepoSetup(...)`. Populates `state.workspaceEnv`. Emits a `system` event if `repo_setup_ran === true`.

Locked shape — every phase file looks like:

```ts
// phases/<name>.ts
import { Effect } from "effect";
import { PhaseFailure } from "./errors.ts";
import type { Phase } from "./types.ts";

export const <name>: Phase = (s) =>
  Effect.gen(function* () {
    const inputs = yield* PhaseInputs;
    // ...real work, calling already-Effect helpers from workspace.ts...
    return { ...s, /* whatever this phase populates */ };
  }).pipe(
    Effect.mapError((cause) => new PhaseFailure({ phase: "<name>", cause })),
  );
```

`PhaseInputs` is a Service Tag introduced in this slice (`phases/inputs.ts`) carrying the per-run static config every phase needs: `issue`, `repo`, `cloneUrl`, `baseBranch`, `runId`, `workspaceRoot`, `skillsSourceDir`, `agentEnv`. It's the Effect-side replacement for the `RunLifecycleDeps` bag — phases consume what they need via the Tag, the run-lifecycle supplies it once via `Layer.succeed` per run.

## Acceptance criteria

- [ ] Four phase files exist under `server/orchestrator/phases/`, each exporting an Effect value matching the `Phase` signature.
- [ ] Each phase wraps its native error in `PhaseFailure` via `Effect.mapError`.
- [ ] `PhaseInputs` Service Tag exists; phases read inputs through it rather than via function parameters.
- [ ] No phase contains canonical-log writes inline — those move to slice 5's enriched `withObservability`. (`skills_installed` and similar one-off log writes that are phase-internal data, not boundary observation, can stay inside the phase — judgement call: if removing it from the phase would lose information unique to that phase's success path, keep it; if it's just "phase X started/finished" telemetry, defer to the boundary.)
- [ ] `run-lifecycle.ts` still works as it did — these phase files are unused so far. The walker swap happens in slice 5.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (`Phase` signature, `PhaseFailure`, `withObservability`)
