// V3 — Effect.iterate with an { i, state, failure } accumulator.
// Mirrors the existing imperative cursor pattern (`let phase: FailurePhase`).
// Partial state on failure stays in the accumulator, so it's recoverable.

import { Effect, Either } from "effect";
import {
	makePhases,
	PHASE_ORDER,
	type PhaseFailure,
	type RunResult,
	type RunState,
	type Scenario,
	type Trace,
} from "../phases.ts";

type Acc = {
	i: number;
	state: RunState;
	failure: PhaseFailure | null;
};

export const runV3 = (
	scenario: Scenario,
	trace: Trace,
): Effect.Effect<RunResult> => {
	const p = makePhases(scenario, trace);
	const initial: Acc = { i: 0, state: {}, failure: null };

	return Effect.iterate(initial, {
		while: (a) => a.i < PHASE_ORDER.length && a.failure === null,
		body: (a) =>
			Effect.gen(function* () {
				const name = PHASE_ORDER[a.i]!;
				const r = yield* Effect.either(p[name](a.state));
				if (Either.isLeft(r)) return { ...a, failure: r.left };
				return { i: a.i + 1, state: r.right, failure: null };
			}),
	}).pipe(
		Effect.map(
			(a): RunResult =>
				a.failure
					? {
							status: "failed",
							phase: a.failure.phase,
							error: a.failure.message,
							state: a.state,
						}
					: { status: "completed", state: a.state },
		),
	);
};
