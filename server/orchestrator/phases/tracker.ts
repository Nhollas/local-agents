import { Effect } from "effect";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const tracker: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		yield* inputs.tracker.transitionState(
			inputs.repo,
			inputs.issue.number,
			"running",
			"awaiting_review",
		);
		return s;
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "tracker", cause })),
	);
