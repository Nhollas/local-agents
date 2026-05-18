import { Effect } from "effect";
import { ensureBranch as ensureBranchOnDisk } from "../workspace.ts";
import { PhaseFailure } from "./errors.ts";
import type { Phase } from "./types.ts";

export const ensureBranch: Phase = (s) =>
	Effect.gen(function* () {
		if (s.wsPath === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "ensure-branch requires state.wsPath",
			});
		}
		if (s.branch === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "ensure-branch requires state.branch",
			});
		}
		yield* ensureBranchOnDisk(s.wsPath, s.branch);
		return s;
	}).pipe(
		Effect.mapError(
			(cause) => new PhaseFailure({ phase: "ensure_branch", cause }),
		),
	);
