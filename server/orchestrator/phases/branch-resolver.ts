import { Effect } from "effect";
import { resolveBranch } from "../../workflow/resolve-branch.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const branchResolver: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		const branch = yield* resolveBranch(inputs.workflow.branch, inputs.scope);
		yield* Effect.annotateCurrentSpan({ branch });
		inputs.runRepo.setRunBranch(inputs.runId, branch);
		return { ...s, branch };
	}).pipe(
		Effect.mapError(
			(cause) => new PhaseFailure({ phase: "branch_resolver", cause }),
		),
	);
