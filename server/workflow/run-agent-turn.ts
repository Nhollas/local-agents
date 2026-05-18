import type { CommandExecutor, FileSystem } from "@effect/platform";
import { Effect, Stream } from "effect";
import type { ModelId } from "../types/model-id.ts";
import {
	AgentInvoker,
	type AgentMessage,
	type OutputFormat,
} from "./agent-invoker.ts";
import { AgentTurnError, type WorkflowExecutionError } from "./errors.ts";
import {
	WorkflowEventEmitter,
	type WorkflowEventEmitterService,
} from "./event-emitter.ts";
import { expandMarkedShellBlocks } from "./shell-expansion.ts";
import { emptyStepUsage, type ModelUsage, type StepUsage } from "./types.ts";

type JsonSchemaDocument = Record<string, unknown>;

type RunAgentTurnInput = {
	prompt: string;
	model: ModelId;
	outputSchema?: JsonSchemaDocument;
	allowedTools?: readonly string[];
	resumeSessionId?: string;
	shellExpansion?: { cwd: string; env: Record<string, string> };
	emitAs:
		| { kind: "branch" }
		| { kind: "step"; name: string; index: number; total: number };
};

type RunAgentTurnResult = {
	structuredOutput: unknown;
	sessionId: string;
	usage: StepUsage;
};

export const runAgentTurn = (
	input: RunAgentTurnInput,
): Effect.Effect<
	RunAgentTurnResult,
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

		const outputFormat: OutputFormat | undefined = input.outputSchema
			? { type: "json_schema", schema: input.outputSchema }
			: undefined;

		const state: TurnState = {
			usage: emptyStepUsage(),
			sessionId: undefined,
			structuredOutput: undefined,
			resultArrived: false,
			failureSubtype: undefined,
		};

		const stream = Stream.fromAsyncIterable(
			invoker.invoke({
				prompt,
				model: input.model,
				...(outputFormat && { outputFormat }),
				...(input.allowedTools && { allowedTools: input.allowedTools }),
				...(input.resumeSessionId && {
					resumeSessionId: input.resumeSessionId,
				}),
				...(input.shellExpansion && { env: input.shellExpansion.env }),
				...(input.emitAs.kind === "step" && { stepName: input.emitAs.name }),
			}),
			(cause) =>
				new AgentTurnError({
					message: cause instanceof Error ? cause.message : String(cause),
				}),
		);

		yield* stream.pipe(
			Stream.runForEach((message) =>
				handleMessage(message, input, state, events),
			),
		);

		if (state.failureSubtype !== undefined) {
			return yield* Effect.fail(
				new AgentTurnError({
					message: state.failureSubtype,
					subtype: state.failureSubtype,
					usage: state.usage,
					...(state.sessionId && { sessionId: state.sessionId }),
				}),
			);
		}
		if (!state.resultArrived || state.sessionId === undefined) {
			return yield* Effect.fail(
				new AgentTurnError({
					message: "agent stream ended without a result message",
					usage: state.usage,
				}),
			);
		}
		return {
			structuredOutput: state.structuredOutput,
			sessionId: state.sessionId,
			usage: state.usage,
		};
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
	);

type TurnState = {
	usage: StepUsage;
	sessionId: string | undefined;
	structuredOutput: unknown;
	resultArrived: boolean;
	failureSubtype: string | undefined;
};

const handleMessage = (
	message: AgentMessage,
	input: RunAgentTurnInput,
	state: TurnState,
	events: WorkflowEventEmitterService,
): Effect.Effect<void> => {
	if (message.type === "assistant") {
		state.sessionId = message.session_id;
		return events.emit(
			input.emitAs.kind === "branch"
				? { _tag: "BranchAssistantMessage", message }
				: {
						_tag: "StepAssistantMessage",
						stepName: input.emitAs.name,
						message,
					},
		);
	}
	if (message.type === "result") {
		state.sessionId = message.session_id;
		state.usage.costUsd += message.total_cost_usd;
		for (const [modelName, m] of Object.entries(message.modelUsage)) {
			const modelUsage: ModelUsage = {
				inputTokens: m.inputTokens,
				outputTokens: m.outputTokens,
				costUSD: m.costUSD,
			};
			state.usage.tokensInput += modelUsage.inputTokens;
			state.usage.tokensOutput += modelUsage.outputTokens;
			const existing = state.usage.modelUsage[modelName];
			state.usage.modelUsage[modelName] = existing
				? {
						inputTokens: existing.inputTokens + modelUsage.inputTokens,
						outputTokens: existing.outputTokens + modelUsage.outputTokens,
						costUSD: existing.costUSD + modelUsage.costUSD,
					}
				: modelUsage;
		}
		if (message.subtype === "success") {
			state.structuredOutput = message.structured_output;
			state.resultArrived = true;
		} else {
			state.failureSubtype = message.subtype;
		}
	}
	return Effect.void;
};
