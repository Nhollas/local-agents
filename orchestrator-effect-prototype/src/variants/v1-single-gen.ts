// V1 — single Effect.gen, sequential phases, Effect.either per phase.
// The most literal port of the existing imperative try/await/catch shape.

import { Effect, Either } from "effect";
import {
	makePhases,
	type PhaseFailure,
	type RunResult,
	type RunState,
	type Scenario,
	type Trace,
} from "../phases.ts";

export const runV1 = (
	scenario: Scenario,
	trace: Trace,
): Effect.Effect<RunResult> =>
	Effect.gen(function* () {
		const p = makePhases(scenario, trace);
		let state: RunState = {};

		const step = function* <A extends PhaseFailure>(
			eff: Effect.Effect<RunState, A>,
		) {
			const r = yield* Effect.either(eff);
			if (Either.isLeft(r)) {
				return { ok: false as const, failure: r.left };
			}
			state = r.right;
			return { ok: true as const };
		};

		const r1 = yield* step(p.workspace(state));
		if (!r1.ok) return failed(r1.failure, state);
		const r2 = yield* step(p.branch_resolver(state));
		if (!r2.ok) return failed(r2.failure, state);
		const r3 = yield* step(p.skills(state));
		if (!r3.ok) return failed(r3.failure, state);
		const r4 = yield* step(p.setup(state));
		if (!r4.ok) return failed(r4.failure, state);
		const r5 = yield* step(p.steps(state));
		if (!r5.ok) return failed(r5.failure, state);
		const r6 = yield* step(p.push(state));
		if (!r6.ok) return failed(r6.failure, state);
		const r7 = yield* step(p.change_request(state));
		if (!r7.ok) return failed(r7.failure, state);
		const r8 = yield* step(p.tracker(state));
		if (!r8.ok) return failed(r8.failure, state);

		return { status: "completed", state } satisfies RunResult;
	});

function failed(err: PhaseFailure, state: RunState): RunResult {
	return { status: "failed", phase: err.phase, error: err.message, state };
}
