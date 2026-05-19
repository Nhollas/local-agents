import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Schema } from "effect";
import type { AgentInvoker } from "./agent-invoker.ts";
import {
	StructuredOutputDecodeError,
	type WorkflowExecutionError,
} from "./errors.ts";
import { WorkflowEventEmitter } from "./event-emitter.ts";
import { renderPrompt } from "./render-prompt.ts";
import { runAgentTurn } from "./run-agent-turn.ts";
import {
	emptyStepUsage,
	type PromptScope,
	type WorkflowBranch,
} from "./types.ts";

export const resolveBranch = (
	workflowBranch: WorkflowBranch,
	scope: PromptScope,
): Effect.Effect<
	string,
	WorkflowExecutionError,
	| AgentInvoker
	| WorkflowEventEmitter
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const events = yield* WorkflowEventEmitter;
		const promptVars = {
			issue: scope.issue,
			base_branch: scope.baseBranch,
		};

		if (typeof workflowBranch === "string") {
			const name = renderPrompt(workflowBranch, promptVars);
			yield* events.emit({
				_tag: "BranchResolved",
				name,
				usage: emptyStepUsage(),
			});
			return name;
		}

		const turn = yield* runAgentTurn({
			prompt: renderPrompt(workflowBranch.prompt, promptVars),
			model: workflowBranch.model,
			outputSchema: workflowBranch.schema,
			emitAs: { kind: "branch" },
		}).pipe(
			Effect.tapError((error) =>
				events.emit({
					_tag: "BranchFailed",
					error,
					usage:
						error._tag === "AgentTurnError" && error.usage
							? error.usage
							: emptyStepUsage(),
				}),
			),
		);

		const decoded = decodeBranchOutput(turn.structuredOutput);
		if (decoded._tag === "Left") {
			const decodeError = new StructuredOutputDecodeError({
				message: "branch agent returned no `name` field in structured output",
				context: "branch",
			});
			yield* events.emit({
				_tag: "BranchFailed",
				error: decodeError,
				usage: turn.usage,
			});
			return yield* Effect.fail(decodeError);
		}

		yield* events.emit({
			_tag: "BranchResolved",
			name: decoded.right.name,
			usage: turn.usage,
		});
		return decoded.right.name;
	}).pipe(
		Effect.annotateLogs({
			"workflow.branch.kind":
				typeof workflowBranch === "string" ? "static" : "agent",
			"workflow.issue.key": scope.issue.key,
		}),
	);

const BranchOutputSchema = Schema.Struct({
	name: Schema.String.pipe(Schema.minLength(1)),
});

const decodeBranchOutput = Schema.decodeUnknownEither(BranchOutputSchema);
