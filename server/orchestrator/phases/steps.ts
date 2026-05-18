import { Effect } from "effect";
import { runSteps } from "../../workflow/run-steps.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const steps: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		if (s.wsPath === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "steps requires state.wsPath",
			});
		}
		if (s.branch === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "steps requires state.branch",
			});
		}
		if (s.workspaceEnv === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "steps requires state.workspaceEnv",
			});
		}
		inputs.runRepo.insertSteps(
			inputs.runId,
			inputs.workflow.steps.map((step, i) => ({
				index: i + 1,
				name: step.name,
			})),
		);
		const outputs = yield* runSteps(
			inputs.workflow.steps,
			inputs.scope,
			s.branch,
			s.wsPath,
			s.workspaceEnv,
		);
		return { ...s, outputs };
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "steps", cause })),
	);
