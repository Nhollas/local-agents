import { Effect } from "effect";
import { renderChangeRequest } from "../../workflow/render-change-request.ts";
import { PhaseFailure } from "./errors.ts";
import { PhaseInputs } from "./inputs.ts";
import type { Phase } from "./types.ts";

export const changeRequest: Phase = (s) =>
	Effect.gen(function* () {
		const inputs = yield* PhaseInputs;
		if (s.branch === undefined) {
			return yield* Effect.fail({
				_tag: "PhaseSetupError" as const,
				message: "change-request requires state.branch",
			});
		}
		const { title, body } = renderChangeRequest(
			inputs.workflow.change_request,
			inputs.scope,
			s.branch,
			s.outputs ?? {},
		);
		const pr = yield* inputs.codeHost.createChangeRequest(
			inputs.repo,
			s.branch,
			inputs.baseBranch,
			title,
			body,
		);
		inputs.runRepo.setRunPr(inputs.runId, {
			repo: inputs.repo,
			number: pr.number,
			url: pr.url,
			kind: "opened",
		});
		yield* Effect.annotateCurrentSpan({ pr_url: pr.url });
		return { ...s, prUrl: pr.url };
	}).pipe(
		Effect.mapError(
			(cause) => new PhaseFailure({ phase: "change_request", cause }),
		),
	);
