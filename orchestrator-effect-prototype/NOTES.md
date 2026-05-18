# Orchestrator Effect-shape prototype — notes

## The question

`server/orchestrator/run-lifecycle.ts` is 503 lines of imperative Promise glue walking a run through phases — workspace prep → branch resolution → skills → setup → step turns → push → change request → tracker transition. Each phase has failure/abort/skip semantics and partial state matters on failure (we keep the workspace for inspection, we record the failure phase to canonical log).

When we rebuild it on Effect, **which shape does the phase walk take?** Four candidates, radically different:

1. **`v1-single-gen`** — one `Effect.gen` with sequential phases, `Effect.either` per phase, manual error funnel. The "naïve port".
2. **`v2-stream-fold`** — model phases as a `Stream`, walk with `Stream.runFoldEffect`. Maximum abstraction.
3. **`v3-iterate-cursor`** — `Effect.iterate` with `{ i, state, failure }` accumulator. The "explicit cursor" shape.
4. **`v4-composed`** — each phase as an exported `Effect` value, composed at the top with `Effect.flatMap`, observability via per-phase `Effect.tap`. The "Effect-idiomatic" shape.

The prototype lets you pick a scenario (happy, fail at phase X, abort midway) and run all four shapes against it, so the differences in readability, error-funnel ergonomics, partial-state recovery on failure, and per-phase observability are visible side by side.

## Verdict

**Chosen shape: `v4-composed.ts`** — phases as named Effect values, composed at the top with `Effect.flatMap`, observability bolted on via a `withObservability` decorator that `Effect.tap`s every phase.

**Why:**

1. **Observability lives on the boundary**, not inside phases. `withObservability` wraps each phase from the outside; the phases stay pure business logic. Matches `migration-standards.md`'s "observability lives on boundaries, not internal methods" rule.
2. **Single failure funnel.** One `matchEffect` at the top converts Effect's failure channel to `RunResult`. v1's eight conversion points violate runner-migration lesson #5 ("dedupe Exit/Cause folding").
3. **Phases are isolable, individually testable Effect values** — each gets its own file in the real implementation.
4. **The top-level walk reads as the list of phases.** Eight `flatMap(p.foo)` lines, nothing else.

**Caveat:** the `Ref<RunState>` used to recover partial state on failure is clever machinery. Likely dissolves in the real implementation once per-phase taps write directly to canonical log — at that point partial state lives in the log, not in a Ref. If the Ref is still present after real observability lands, it's a smell.

**What this means for the orchestrator migration slice docs:**

- Each slice that touches a phase can say "implement the phase as a `(state) => Effect<state, PhaseFailure>` value; the walker composes them via `Effect.flatMap`. Follow `orchestrator-effect-prototype/src/variants/v4-composed.ts` for the composition shape and `withObservability` for the tap pattern."
- Phase files live one-per-file under `server/orchestrator/phases/` (or similar) so each is independently testable.
- Canonical-log writes and event emission ride on per-phase `Effect.tap` / `Effect.tapError` in `withObservability`, not inside phase bodies.

## Run

```
pnpm prototype:orchestrator
```

Keys: `[s]` cycle scenario · `[1/2/3/4]` focus one variant · `[a]` show all four · `[r]` run · `[q]` quit
