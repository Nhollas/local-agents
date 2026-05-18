// V4 — phases composed at the top with Effect.flatMap.
// Each phase is an isolable named value; observability is per-phase via tap, so
// partial state on success and partial info on failure both flow through taps
// rather than needing to be reconstructed after the walk.

import { Effect, Ref } from "effect";
import {
	makePhases,
	type Phase,
	type PhaseName,
	type RunResult,
	type RunState,
	type Scenario,
	type Trace,
} from "../phases.ts";

export const runV4 = (
	scenario: Scenario,
	trace: Trace,
): Effect.Effect<RunResult> =>
	Effect.gen(function* () {
		const p = makePhases(scenario, trace);
		const lastState = yield* Ref.make<RunState>({});
		const observed = withObservability(lastState, trace);

		return yield* observed(
			"workspace",
			p.workspace,
		)({}).pipe(
			Effect.flatMap(observed("branch_resolver", p.branch_resolver)),
			Effect.flatMap(observed("skills", p.skills)),
			Effect.flatMap(observed("setup", p.setup)),
			Effect.flatMap(observed("steps", p.steps)),
			Effect.flatMap(observed("push", p.push)),
			Effect.flatMap(observed("change_request", p.change_request)),
			Effect.flatMap(observed("tracker", p.tracker)),
			Effect.matchEffect({
				onSuccess: (state) =>
					Effect.succeed<RunResult>({ status: "completed", state }),
				onFailure: (err) =>
					Ref.get(lastState).pipe(
						Effect.map(
							(state): RunResult => ({
								status: "failed",
								phase: err.phase,
								error: err.message,
								state,
							}),
						),
					),
			}),
		);
	});

function withObservability(lastState: Ref.Ref<RunState>, trace: Trace) {
	return (name: PhaseName, phase: Phase): Phase =>
		(s) =>
			phase(s).pipe(
				Effect.tap((next) => Ref.set(lastState, next)),
				Effect.tapError((err) =>
					Effect.sync(() => {
						trace.push(`  ~ observed failure at ${name}: ${err.message}`);
					}),
				),
			);
}
