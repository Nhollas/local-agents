import { Effect } from "effect";
import { pushBranch } from "../workspace.ts";
import { PhaseFailure } from "./errors.ts";
import type { Phase } from "./types.ts";

export const push: Phase = (s) =>
	Effect.gen(function* () {
		if (s.wsPath === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "push requires state.wsPath",
			});
		}
		if (s.branch === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "push requires state.branch",
			});
		}
		yield* pushBranch(s.wsPath, s.branch);
		return s;
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "push", cause })),
	);
