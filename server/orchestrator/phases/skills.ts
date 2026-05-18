import { Effect } from "effect";
import { installSkills } from "../workspace.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const skills: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		if (s.wsPath === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "skills requires state.wsPath",
			});
		}
		if (s.branch === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "skills requires state.branch",
			});
		}
		const result = yield* installSkills(s.wsPath, inputs.skillsSourceDir, {
			issue: inputs.issue,
			branch: s.branch,
			base_branch: inputs.baseBranch,
		});
		yield* Effect.annotateCurrentSpan({
			"skills.installed": result.installed.join(","),
			"skills.skipped": result.skipped.join(","),
			"skills.installed_count": result.installed.length,
			"skills.skipped_count": result.skipped.length,
		});
		if (result.installed.length > 0 || result.skipped.length > 0) {
			inputs.emit({
				kind: "system",
				stepName: null,
				data: {
					message: `skills installed: ${result.installed.length} (skipped ${result.skipped.length})`,
					command: null,
					path: null,
					exitCode: null,
				},
			});
		}
		return s;
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "skills", cause })),
	);
