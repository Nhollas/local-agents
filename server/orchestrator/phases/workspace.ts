import { Effect } from "effect";
import { createWorkspace } from "../workspace.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const workspace: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		const wsPath = yield* createWorkspace(
			inputs.issue,
			inputs.workspaceRoot,
			inputs.cloneUrl,
			inputs.runId,
		);
		inputs.runRepo.setRunWorkspaceDir(inputs.runId, wsPath);
		return { ...s, wsPath };
	}).pipe(
		Effect.mapError((cause) => new PhaseFailure({ phase: "workspace", cause })),
	);
