import { Effect, Ref } from "effect";
import { branchResolver } from "./phases/branch-resolver.ts";
import { changeRequest } from "./phases/change-request.ts";
import { ensureBranch } from "./phases/ensure-branch.ts";
import type { PhaseFailure } from "./phases/errors.ts";
import { PhaseInputs } from "./phases/inputs.ts";
import { push } from "./phases/push.ts";
import { setup } from "./phases/setup.ts";
import { skills } from "./phases/skills.ts";
import { steps } from "./phases/steps.ts";
import { tracker } from "./phases/tracker.ts";
import type { PhaseDeps, RunResult, RunState } from "./phases/types.ts";
import { withObservability } from "./phases/with-observability.ts";
import { workspace } from "./phases/workspace.ts";

export const runLifecycleWalker: Effect.Effect<RunResult, never, PhaseDeps> =
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		const lastState = yield* Ref.make<RunState>({});
		const observe = withObservability({ lastState, emit: inputs.emit });

		return yield* observe(
			"workspace",
			workspace,
		)({}).pipe(
			Effect.flatMap(observe("branch_resolver", branchResolver)),
			Effect.flatMap(observe("ensure_branch", ensureBranch)),
			Effect.flatMap(observe("skills", skills)),
			Effect.flatMap(observe("setup", setup)),
			Effect.flatMap(observe("steps", steps)),
			Effect.flatMap(observe("push", push)),
			Effect.flatMap(observe("change_request", changeRequest)),
			Effect.flatMap(observe("tracker", tracker)),
			Effect.matchEffect({
				onSuccess: (state) =>
					Effect.succeed<RunResult>({ status: "completed", state }),
				onFailure: (err: PhaseFailure) =>
					Ref.get(lastState).pipe(
						Effect.map(
							(state): RunResult => ({
								status: "failed",
								phase: err.phase,
								cause: err.cause,
								state,
							}),
						),
					),
			}),
		);
	});
