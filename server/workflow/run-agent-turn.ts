import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Option, Stream } from "effect";
import { AgentInvoker, type AgentMessage } from "./agent-invoker.ts";
import { AgentTurnError, type WorkflowExecutionError } from "./errors.ts";
import { WorkflowEventEmitter } from "./event-emitter.ts";
import type { ModelId } from "./model-id.ts";
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

		const messages = Stream.unwrapScoped(
			invoker
				.invoke({
					prompt,
					model: input.model,
					outputFormat: input.outputSchema && {
						type: "json_schema",
						schema: input.outputSchema,
					},
					allowedTools: input.allowedTools,
					resumeSessionId: input.resumeSessionId,
					env: input.shellExpansion?.env,
					stepName:
						input.emitAs.kind === "step" ? input.emitAs.name : undefined,
				})
				.pipe(
					Effect.map((iterable) =>
						Stream.fromAsyncIterable(
							iterable,
							(cause) =>
								new AgentTurnError({
									message:
										cause instanceof Error ? cause.message : String(cause),
								}),
						),
					),
				),
		);

		const resultOption = yield* messages.pipe(
			Stream.tap((message) =>
				message.type === "assistant"
					? events.emit(
							input.emitAs.kind === "branch"
								? { _tag: "BranchAssistantMessage", message }
								: {
										_tag: "StepAssistantMessage",
										stepName: input.emitAs.name,
										message,
									},
						)
					: Effect.void,
			),
			Stream.filter(
				(message): message is ResultMessage => message.type === "result",
			),
			Stream.runHead,
		);

		if (Option.isNone(resultOption)) {
			return yield* Effect.fail(
				new AgentTurnError({
					message: "agent stream ended without a result message",
					usage: emptyStepUsage(),
				}),
			);
		}

		const result = resultOption.value;
		const usage = mergeUsage(emptyStepUsage(), result);

		if (result.subtype !== "success") {
			return yield* Effect.fail(
				new AgentTurnError({
					message: result.subtype,
					subtype: result.subtype,
					usage,
					sessionId: result.session_id,
				}),
			);
		}

		return {
			structuredOutput: result.structured_output,
			sessionId: result.session_id,
			usage,
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
