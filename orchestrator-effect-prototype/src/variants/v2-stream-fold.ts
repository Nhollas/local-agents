// V2 — phases as a Stream, walked with Stream.runFoldEffect.
// Maximum abstraction: the walk is one declarative pipeline. Trades away the
// ability to read partial state on failure — runFoldEffect drops the
// accumulator when the inner effect fails.

import { Effect, Stream } from "effect";
import {
	makePhases,
	PHASE_ORDER,
	type RunResult,
	type RunState,
	type Scenario,
	type Trace,
} from "../phases.ts";

export const runV2 = (
	scenario: Scenario,
	trace: Trace,
): Effect.Effect<RunResult> => {
	const p = makePhases(scenario, trace);
	return Stream.fromIterable(PHASE_ORDER).pipe(
		Stream.runFoldEffect({} as RunState, (state, name) => p[name](state)),
		Effect.match({
			onSuccess: (state): RunResult => ({ status: "completed", state }),
			onFailure: (err): RunResult => ({
				status: "failed",
				phase: err.phase,
				error: err.message,
				state: {}, // ← partial state on failure is unrecoverable here
			}),
		}),
	);
};
