import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { AgentInvoker } from "./agent-invoker.ts";
import {
	AgentTurnError,
	StructuredOutputDecodeError,
	type WorkflowExecutionError,
} from "./errors.ts";
import { WorkflowEventEmitter } from "./event-emitter.ts";
import { renderPrompt } from "./render-prompt.ts";
import { runAgentTurn } from "./run-agent-turn.ts";
import { markTrustedShellBlocks } from "./shell-expansion.ts";
import type { PromptScope, WorkflowStep } from "./types.ts";

export const runSteps = (
	steps: ReadonlyArray<WorkflowStep>,
	scope: PromptScope,
	branch: string,
	cwd: string,
	env?: Record<string, string>,
): Effect.Effect<
	Record<string, unknown>,
	WorkflowExecutionError,
	| AgentInvoker
	| WorkflowEventEmitter
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const events = yield* WorkflowEventEmitter;
		const outputs: Record<string, unknown> = {};
		let previousSessionId: string | undefined;
		const total = steps.length;

		const failStep = (
			stepName: string,
			index: number,
			startedAt: number,
			error: WorkflowExecutionError,
		): Effect.Effect<never, WorkflowExecutionError> =>
			Effect.gen(function* () {
				if (error instanceof AgentTurnError && error.usage && error.sessionId) {
					yield* events.emit({
						_tag: "StepResult",
						stepName,
						sessionId: error.sessionId,
						usage: error.usage,
					});
				}
				const stepError =
					error._tag === "AgentTurnError" &&
					error.subtype === "error_max_structured_output_retries"
						? new StructuredOutputDecodeError({
								message: error.message,
								context: "step",
							})
						: error;
				yield* events.emit({
					_tag: "StepFailed",
					stepName,
					index,
					error: stepError,
					durationMs: Date.now() - startedAt,
				});
				return yield* Effect.fail(stepError);
			});

		for (const [zeroBasedIndex, step] of steps.entries()) {
			const index = zeroBasedIndex + 1;
			const startedAt = Date.now();

			yield* events.emit({
				_tag: "StepStarted",
				name: step.name,
				index,
				total,
			});

			const resumeSessionId = step.resume_previous
				? previousSessionId
				: undefined;
			const renderedPrompt = renderPrompt(markTrustedShellBlocks(step.prompt), {
				issue: scope.issue,
				branch,
				base_branch: scope.baseBranch,
				outputs,
			});

			const turnResult = yield* runAgentTurn({
				prompt: renderedPrompt,
				model: step.model,
				outputSchema: step.output_schema,
				allowedTools: step.allowed_tools,
				resumeSessionId,
				shellExpansion: { cwd, env: env ?? {} },
				emitAs: { kind: "step", name: step.name, index, total },
			}).pipe(
				Effect.catchAll((error) =>
					failStep(step.name, index, startedAt, error),
				),
			);

			yield* events.emit({
				_tag: "StepResult",
				stepName: step.name,
				sessionId: turnResult.sessionId,
				usage: turnResult.usage,
				structuredOutput: step.output_schema
					? turnResult.structuredOutput
					: undefined,
			});

			if (step.output_schema) {
				outputs[step.name] = turnResult.structuredOutput;
			}

			previousSessionId = turnResult.sessionId;

			yield* events.emit({
				_tag: "StepCompleted",
				stepName: step.name,
				index,
				durationMs: Date.now() - startedAt,
			});
		}

		return outputs;
	}).pipe(
		Effect.annotateLogs({
			"workflow.branch": branch,
			"workflow.steps.total": steps.length,
		}),
	);
