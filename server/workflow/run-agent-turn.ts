import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Stream } from "effect";
import type { ModelId } from "../types/model-id.ts";
import { AgentInvoker, type AgentMessage } from "./agent-invoker.ts";
import { AgentTurnError, type WorkflowExecutionError } from "./errors.ts";
import { WorkflowEventEmitter } from "./event-emitter.ts";
import { expandMarkedShellBlocks } from "./shell-expansion.ts";
import { emptyStepUsage, type StepUsage } from "./types.ts";

type AgentTurnInput = {
	prompt: string;
	model: ModelId;
	outputSchema?: Record<string, unknown> | undefined;
	allowedTools?: readonly string[] | undefined;
	resumeSessionId?: string | undefined;
	shellExpansion?: { cwd: string; env: Record<string, string> } | undefined;
	emitAs:
		| { kind: "branch" }
		| { kind: "step"; name: string; index: number; total: number };
};

type AgentTurnOutcome = {
	structuredOutput: unknown;
	sessionId: string;
	usage: StepUsage;
};

export const runAgentTurn = (
	input: AgentTurnInput,
): Effect.Effect<
	AgentTurnOutcome,
	WorkflowExecutionError,
	| AgentInvoker
	| WorkflowEventEmitter
	| CommandExecutor.CommandExecutor
	| FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const invoker = yield* AgentInvoker;
		const events = yield* WorkflowEventEmitter;

		const prompt = input.shellExpansion
			? yield* expandMarkedShellBlocks(input.prompt, {
					cwd: input.shellExpansion.cwd,
					env: input.shellExpansion.env,
					stepName: input.emitAs.kind === "step" ? input.emitAs.name : "branch",
				})
			: input.prompt;

		const messages = Stream.fromAsyncIterable(
			invoker.invoke({
				prompt,
				model: input.model,
				outputFormat: input.outputSchema && {
					type: "json_schema",
					schema: input.outputSchema,
				},
				allowedTools: input.allowedTools,
				resumeSessionId: input.resumeSessionId,
				env: input.shellExpansion?.env,
				stepName: input.emitAs.kind === "step" ? input.emitAs.name : undefined,
			}),
			(cause) =>
				new AgentTurnError({
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		);

		const outcome = yield* Stream.runFoldEffect(
			messages,
			initialState,
			(state, message) => {
				if (message.type === "assistant") {
					return events
						.emit(
							input.emitAs.kind === "branch"
								? { _tag: "BranchAssistantMessage", message }
								: {
										_tag: "StepAssistantMessage",
										stepName: input.emitAs.name,
										message,
									},
						)
						.pipe(Effect.as({ ...state, sessionId: message.session_id }));
				}
				if (message.type === "result") {
					const usage = mergeUsage(state.usage, message);
					return Effect.succeed(
						message.subtype === "success"
							? {
									...state,
									usage,
									sessionId: message.session_id,
									structuredOutput: message.structured_output,
									resultArrived: true,
								}
							: {
									...state,
									usage,
									sessionId: message.session_id,
									failureSubtype: message.subtype,
								},
					);
				}
				return Effect.succeed(state);
			},
		);

		if (outcome.failureSubtype !== undefined) {
			return yield* Effect.fail(
				new AgentTurnError({
					message: outcome.failureSubtype,
					subtype: outcome.failureSubtype,
					usage: outcome.usage,
					sessionId: outcome.sessionId,
				}),
			);
		}
		if (!outcome.resultArrived || outcome.sessionId === undefined) {
			return yield* Effect.fail(
				new AgentTurnError({
					message: "agent stream ended without a result message",
					usage: outcome.usage,
				}),
			);
		}
		return {
			structuredOutput: outcome.structuredOutput,
			sessionId: outcome.sessionId,
			usage: outcome.usage,
		} satisfies AgentTurnOutcome;
	}).pipe(
		Effect.withSpan("workflow.agent_turn", {
			attributes: {
				model: input.model,
				"emit.kind": input.emitAs.kind,
				...(input.emitAs.kind === "step" && {
					"step.name": input.emitAs.name,
					"step.index": input.emitAs.index,
				}),
				...(input.resumeSessionId && {
					"resume.session_id": input.resumeSessionId,
				}),
			},
		}),
		Effect.annotateLogs({
			"workflow.model": input.model,
			"workflow.emit.kind": input.emitAs.kind,
			...(input.emitAs.kind === "step" && {
				"workflow.step.name": input.emitAs.name,
				"workflow.step.index": input.emitAs.index,
			}),
		}),
	);

type TurnState = {
	usage: StepUsage;
	sessionId: string | undefined;
	structuredOutput: unknown;
	resultArrived: boolean;
	failureSubtype: string | undefined;
};

const initialState: TurnState = {
	usage: emptyStepUsage(),
	sessionId: undefined,
	structuredOutput: undefined,
	resultArrived: false,
	failureSubtype: undefined,
};

type ResultMessage = Extract<AgentMessage, { type: "result" }>;

function mergeUsage(running: StepUsage, message: ResultMessage): StepUsage {
	const merged: StepUsage = {
		...running,
		costUsd: running.costUsd + message.total_cost_usd,
		modelUsage: { ...running.modelUsage },
	};
	for (const [model, { inputTokens, outputTokens, costUSD }] of Object.entries(
		message.modelUsage,
	)) {
		merged.tokensInput += inputTokens;
		merged.tokensOutput += outputTokens;
		const prior = merged.modelUsage[model];
		merged.modelUsage[model] = prior
			? {
					inputTokens: prior.inputTokens + inputTokens,
					outputTokens: prior.outputTokens + outputTokens,
					costUSD: prior.costUSD + costUSD,
				}
			: { inputTokens, outputTokens, costUSD };
	}
	return merged;
}
