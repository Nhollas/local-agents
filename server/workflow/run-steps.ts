import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect } from "effect";
import type { AgentInvoker } from "./agent-invoker.ts";
import {
	type AgentTurnError,
	type ShellExpansionError,
	StructuredOutputDecodeError,
	type WorkflowExecutionError,
} from "./errors.ts";
import { WorkflowEventEmitter } from "./event-emitter.ts";
import { annotateStepDiff, captureHead } from "./measure-step-diff.ts";
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
		const outputs: Record<string, unknown> = {};
		let previousSessionId: string | undefined;
		const total = steps.length;

		for (const [zeroBasedIndex, step] of steps.entries()) {
			const index = zeroBasedIndex + 1;

			previousSessionId = yield* runOneStep({
				step,
				index,
				total,
				scope,
				branch,
				cwd,
				env,
				outputs,
				previousSessionId,
			}).pipe(
				Effect.withSpan(`step:${step.name}`, {
					attributes: {
						"workflow.step": step.name,
						"langfuse.observation.metadata.step_name": step.name,
					},
				}),
			);
		}

		return outputs;
	}).pipe(
		Effect.annotateLogs({
			"workflow.branch": branch,
			"workflow.steps.total": steps.length,
		}),
	);

type RunOneStepParams = {
	step: WorkflowStep;
	index: number;
	total: number;
	scope: PromptScope;
	branch: string;
	cwd: string;
	env: Record<string, string> | undefined;
	outputs: Record<string, unknown>;
	previousSessionId: string | undefined;
};

const runOneStep = ({
	step,
	index,
	total,
	scope,
	branch,
	cwd,
	env,
	outputs,
	previousSessionId,
}: RunOneStepParams): Effect.Effect<
	string,
	WorkflowExecutionError,
	| AgentInvoker
	| WorkflowEventEmitter
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const events = yield* WorkflowEventEmitter;
		const startedAt = Date.now();

		yield* events.emit({
			_tag: "StepStarted",
			name: step.name,
			index,
			total,
		});

		const headBefore = step.measure_diff ? captureHead(cwd) : null;

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
			Effect.catchTag("AgentTurnError", (error) =>
				failAgentTurn(events, step.name, index, startedAt, error),
			),
			Effect.catchTag("ShellExpansionError", (error) =>
				failStep(events, step.name, index, startedAt, error),
			),
			Effect.catchTag("StructuredOutputDecodeError", (error) =>
				failStep(events, step.name, index, startedAt, error),
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

		if (headBefore != null) yield* annotateStepDiff(cwd, headBefore);

		yield* events.emit({
			_tag: "StepCompleted",
			stepName: step.name,
			index,
			durationMs: Date.now() - startedAt,
		});

		return turnResult.sessionId;
	});

const failAgentTurn = (
	events: WorkflowEventEmitter["Type"],
	stepName: string,
	index: number,
	startedAt: number,
	error: AgentTurnError,
): Effect.Effect<never, WorkflowExecutionError> =>
	Effect.gen(function* () {
		if (error.usage && error.sessionId) {
			yield* events.emit({
				_tag: "StepResult",
				stepName,
				sessionId: error.sessionId,
				usage: error.usage,
			});
		}
		const mapped =
			error.subtype === "error_max_structured_output_retries"
				? new StructuredOutputDecodeError({
						message: error.message,
						context: "step",
					})
				: error;
		return yield* failStep(events, stepName, index, startedAt, mapped);
	});

const failStep = (
	events: WorkflowEventEmitter["Type"],
	stepName: string,
	index: number,
	startedAt: number,
	error: ShellExpansionError | AgentTurnError | StructuredOutputDecodeError,
): Effect.Effect<never, WorkflowExecutionError> =>
	Effect.gen(function* () {
		yield* events.emit({
			_tag: "StepFailed",
			stepName,
			index,
			error,
			durationMs: Date.now() - startedAt,
		});
		return yield* Effect.fail(error);
	});
