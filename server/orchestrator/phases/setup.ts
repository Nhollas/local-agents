import { Effect } from "effect";
import { resolveWorkspaceEnvironment, runRepoSetup } from "../workspace.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const setup: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		if (s.wsPath === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "setup requires state.wsPath",
			});
		}
		const workspaceEnv = yield* resolveWorkspaceEnvironment(
			s.wsPath,
			inputs.agentEnv,
		);
		const repoSetupRan = yield* runRepoSetup(s.wsPath, workspaceEnv);
		yield* Effect.annotateCurrentSpan({ repo_setup_ran: repoSetupRan });
		if (repoSetupRan) {
			inputs.emit({
				kind: "system",
				stepName: null,
				data: {
					message: "repo setup ran",
					command: ".agent/setup.sh",
					path: s.wsPath,
					exitCode: 0,
				},
			});
		}
		return { ...s, workspaceEnv };
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "setup", cause })),
	);
