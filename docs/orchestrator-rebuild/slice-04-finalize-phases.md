# Slice 4 — Finalize phases as files

## Read first

This slice doc, [`../migration-standards.md`](../migration-standards.md), [`../adr/0001-phase-outputs-and-fixed-lifecycle.md`](../adr/0001-phase-outputs-and-fixed-lifecycle.md) (for the locked finalize order), and the `finalizeSuccess` function in the existing `run-lifecycle.ts`. Skim `server/code-hosts/types.ts` and `server/trackers/types.ts` for the adapter shapes these phases call into.

## What to build

The three phases that run **only after** `steps` succeeds: push the branch, open the change request, transition the tracker issue. The order is pinned by ADR 0001 — do not reorder.

Land in `server/orchestrator/phases/`:

- `push.ts` — wraps `pushBranch(wsPath, branch)`. No state change.
- `change-request.ts` — calls `renderChangeRequest(workflow.change_request, scope, branch, outputs)` (pure) then `codeHost.createChangeRequest(...)`. Populates `state.prUrl`. Sets `runRepo.setRunPr` as a tap.
- `tracker.ts` — calls `tracker.transitionState(repo, issue.number, "running", "awaiting_review")`. No state change.

Locked: these phases extend the `PhaseFailureCause` union from slice 1 to include `CodeHostError` and `TrackerError` (whatever the exact tagged-error names are in `code-hosts/errors.ts` and `trackers/errors.ts`). Update `phases/errors.ts` accordingly.

The "only run after steps succeeds" semantics live in the **walker** (slice 5) — these phase files don't know about it. They are unconditional phase Effects; conditional execution is a walker concern. The walker either runs the chain to completion (success → finalize phases also run) or stops at the failing phase (finalize phases never start). This is exactly how the v4 prototype handles it.

## Acceptance criteria

- [ ] Three phase files exist under `server/orchestrator/phases/`, each exporting an Effect value matching the `Phase` signature.
- [ ] `phases/errors.ts` `PhaseFailureCause` union extended with the code-host and tracker error tags.
- [ ] Phases call into already-migrated `code-hosts/` and `trackers/` adapters directly — no Promise bridges.
- [ ] Finalize order in the eventual walker matches ADR 0001: push → change_request → tracker. (Enforced in slice 5.)
- [ ] `run-lifecycle.ts` still works as it did — these phase files are unused so far. The walker swap happens in slice 5.
- [ ] No `as` casts, no Zod, no interface wrappers.
- [ ] `pnpm typecheck && pnpm test` green.

## Blocked by

- Slice 1 (`Phase` signature, `PhaseFailure`)
- Slice 2 (`PhaseInputs` Service Tag)
