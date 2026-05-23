import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Queue } from "effect";
import { describe, expect, it } from "vitest";
import { issueKey, issueNumber } from "../types/brands.ts";
import {
	AgentInvoker,
	type AgentInvokerService,
	type AgentMessage,
} from "./agent-invoker.ts";
import { type WorkflowEvent, WorkflowEventEmitter } from "./event-emitter.ts";
import { resolveBranch } from "./resolve-branch.ts";
import type { PromptScope, WorkflowBranch } from "./types.ts";

const PlatformLayer = Layer.merge(
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

const scope: PromptScope = {
	issue: {
		key: issueKey("TEST-42"),
		number: issueNumber(42),
		title: "Add widget",
		description: "Add widgets to the dashboard.",
		labels: [],
		url: "https://tracker.example.test/TEST-42",
		createdAt: "2026-01-01T00:00:00.000Z",
	},
	baseBranch: "main",
};

const branchSchema = {
	type: "object",
	properties: { name: { type: "string" } },
	required: ["name"],
} as const;

type Recording = {
	calls: Array<{ prompt: string; model: string; hasSchema: boolean }>;
};

function stubInvoker(
	messages: AgentMessage[],
	recording: Recording = { calls: [] },
): AgentInvokerService {
	return {
		invoke({ prompt, model, outputFormat }) {
			recording.calls.push({
				prompt,
				model,
				hasSchema: outputFormat != null,
			});
			return Effect.succeed(
				(async function* () {
					for (const msg of messages) yield msg;
				})(),
			);
		},
	};
}

const fakeSessionId = "session-test";

function runResolve(
	workflowBranch: WorkflowBranch,
	invoker: AgentInvokerService,
) {
	return Effect.gen(function* () {
		const queue = yield* Queue.unbounded<WorkflowEvent>();
		const layers = Layer.mergeAll(
			Layer.succeed(AgentInvoker, AgentInvoker.make(invoker)),
			WorkflowEventEmitter.Default(queue),
		);
		const result = yield* Effect.either(
			resolveBranch(workflowBranch, scope).pipe(Effect.provide(layers)),
		);
		const events = yield* Queue.takeAll(queue);
		return { result, events: [...events] };
	}).pipe(Effect.provide(PlatformLayer));
}

function resultMessage(overrides: {
	subtype: "success" | "error_max_structured_output_retries";
	structured_output?: unknown;
	modelUsage?: Record<
		string,
		{ inputTokens: number; outputTokens: number; costUSD: number }
	>;
	total_cost_usd?: number;
}): AgentMessage {
	const baseSuccess = {
		type: "result" as const,
		duration_ms: 0,
		duration_api_ms: 0,
		is_error: false,
		num_turns: 1,
		result: "",
		stop_reason: null,
		total_cost_usd: overrides.total_cost_usd ?? 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		modelUsage: Object.fromEntries(
			Object.entries(overrides.modelUsage ?? {}).map(([k, v]) => [
				k,
				{
					inputTokens: v.inputTokens,
					outputTokens: v.outputTokens,
					cacheReadInputTokens: 0,
					cacheCreationInputTokens: 0,
					webSearchRequests: 0,
					costUSD: v.costUSD,
					contextWindow: 0,
					maxOutputTokens: 0,
				},
			]),
		),
		permission_denials: [],
		uuid: "00000000-0000-4000-8000-000000000001",
		session_id: fakeSessionId,
	};
	if (overrides.subtype === "success") {
		return {
			...baseSuccess,
			subtype: "success",
			structured_output: overrides.structured_output,
		} as unknown as AgentMessage;
	}
	return {
		...baseSuccess,
		subtype: overrides.subtype,
		errors: [],
	} as unknown as AgentMessage;
}

describe("resolveBranch", () => {
	it("literal branch template skips the agent and emits BranchResolved with zero usage", async () => {
		const recording: Recording = { calls: [] };
		const invoker = stubInvoker([], recording);
		const { result, events } = await Effect.runPromise(
			runResolve("agent/issue-{{ issue.number }}", invoker),
		);

		expect(recording.calls).toEqual([]);
		expect(result).toMatchObject({ _tag: "Right", right: "agent/issue-42" });
		expect(events).toEqual([
			{
				_tag: "BranchResolved",
				name: "agent/issue-42",
				usage: {
					costUsd: 0,
					tokensInput: 0,
					tokensOutput: 0,
					modelUsage: {},
				},
			},
		]);
	});

	it("dynamic branch form invokes the agent with the schema and a rendered prompt", async () => {
		const recording: Recording = { calls: [] };
		const invoker = stubInvoker(
			[
				resultMessage({
					subtype: "success",
					structured_output: { name: "agent/decided-branch" },
					modelUsage: {
						"claude-sonnet-4-6": {
							inputTokens: 100,
							outputTokens: 50,
							costUSD: 0.02,
						},
					},
					total_cost_usd: 0.02,
				}),
			],
			recording,
		);
		const { result, events } = await Effect.runPromise(
			runResolve(
				{
					prompt: "Pick a branch for {{ issue.key }}",
					schema: branchSchema,
					model: "claude-sonnet-4-6",
				},
				invoker,
			),
		);

		expect(recording.calls).toEqual([
			{
				prompt: "Pick a branch for TEST-42",
				model: "claude-sonnet-4-6",
				hasSchema: true,
			},
		]);
		expect(result).toMatchObject({
			_tag: "Right",
			right: "agent/decided-branch",
		});
		expect(events).toEqual([
			{
				_tag: "BranchResolved",
				name: "agent/decided-branch",
				usage: {
					costUsd: 0.02,
					tokensInput: 100,
					tokensOutput: 50,
					modelUsage: {
						"claude-sonnet-4-6": {
							inputTokens: 100,
							outputTokens: 50,
							costUSD: 0.02,
						},
					},
				},
			},
		]);
	});

	it("missing `name` in structured output fails with StructuredOutputDecodeError { context: 'branch' }", async () => {
		const invoker = stubInvoker([
			resultMessage({
				subtype: "success",
				structured_output: { wrong_key: "x" },
				modelUsage: {
					"claude-sonnet-4-6": {
						inputTokens: 10,
						outputTokens: 5,
						costUSD: 0.001,
					},
				},
				total_cost_usd: 0.001,
			}),
		]);
		const { result, events } = await Effect.runPromise(
			runResolve(
				{
					prompt: "x",
					schema: branchSchema,
					model: "claude-sonnet-4-6",
				},
				invoker,
			),
		);

		if (result._tag !== "Left") throw new Error("expected failure");
		if (result.left._tag !== "StructuredOutputDecodeError") {
			throw new Error(
				`expected StructuredOutputDecodeError, got ${result.left._tag}`,
			);
		}
		expect(result.left.context).toBe("branch");
		expect(events.length).toBe(1);
		const failed = events[0];
		if (failed?._tag !== "BranchFailed")
			throw new Error("expected BranchFailed");
		expect(failed.error._tag).toBe("StructuredOutputDecodeError");
		expect(failed.usage.costUsd).toBe(0.001);
		expect(failed.usage.modelUsage["claude-sonnet-4-6"]).toEqual({
			inputTokens: 10,
			outputTokens: 5,
			costUSD: 0.001,
		});
	});

	it("agent stream ends without a result message — fails with AgentTurnError", async () => {
		const invoker = stubInvoker([]);
		const { result, events } = await Effect.runPromise(
			runResolve(
				{
					prompt: "x",
					schema: branchSchema,
					model: "claude-sonnet-4-6",
				},
				invoker,
			),
		);

		if (result._tag !== "Left") throw new Error("expected failure");
		if (result.left._tag !== "AgentTurnError") {
			throw new Error(`expected AgentTurnError, got ${result.left._tag}`);
		}
		const failed = events[0];
		if (failed?._tag !== "BranchFailed")
			throw new Error("expected BranchFailed");
		expect(failed.error._tag).toBe("AgentTurnError");
		expect(failed.usage).toEqual({
			costUsd: 0,
			tokensInput: 0,
			tokensOutput: 0,
			modelUsage: {},
		});
	});

	it("result subtype error_max_structured_output_retries fails with AgentTurnError carrying that subtype, usage from the result message preserved", async () => {
		const invoker = stubInvoker([
			resultMessage({
				subtype: "error_max_structured_output_retries",
				modelUsage: {
					"claude-sonnet-4-6": {
						inputTokens: 200,
						outputTokens: 80,
						costUSD: 0.04,
					},
				},
				total_cost_usd: 0.04,
			}),
		]);
		const { result, events } = await Effect.runPromise(
			runResolve(
				{
					prompt: "x",
					schema: branchSchema,
					model: "claude-sonnet-4-6",
				},
				invoker,
			),
		);

		if (result._tag !== "Left") throw new Error("expected failure");
		if (result.left._tag !== "AgentTurnError") {
			throw new Error(`expected AgentTurnError, got ${result.left._tag}`);
		}
		expect(result.left.subtype).toBe("error_max_structured_output_retries");
		const failed = events[0];
		if (failed?._tag !== "BranchFailed")
			throw new Error("expected BranchFailed");
		expect(failed.usage.costUsd).toBe(0.04);
		expect(failed.usage.modelUsage["claude-sonnet-4-6"]).toEqual({
			inputTokens: 200,
			outputTokens: 80,
			costUSD: 0.04,
		});
	});

	it("multi-model usage is aggregated per model on BranchResolved", async () => {
		const invoker = stubInvoker([
			resultMessage({
				subtype: "success",
				structured_output: { name: "feature/multi" },
				modelUsage: {
					"claude-sonnet-4-6": {
						inputTokens: 100,
						outputTokens: 40,
						costUSD: 0.02,
					},
					"claude-haiku-4-5": {
						inputTokens: 300,
						outputTokens: 10,
						costUSD: 0.005,
					},
				},
				total_cost_usd: 0.025,
			}),
		]);
		const { events } = await Effect.runPromise(
			runResolve(
				{
					prompt: "x",
					schema: branchSchema,
					model: "claude-sonnet-4-6",
				},
				invoker,
			),
		);
		const resolved = events[0];
		if (resolved?._tag !== "BranchResolved") {
			throw new Error("expected BranchResolved");
		}
		expect(resolved.usage).toEqual({
			costUsd: 0.025,
			tokensInput: 400,
			tokensOutput: 50,
			modelUsage: {
				"claude-sonnet-4-6": {
					inputTokens: 100,
					outputTokens: 40,
					costUSD: 0.02,
				},
				"claude-haiku-4-5": {
					inputTokens: 300,
					outputTokens: 10,
					costUSD: 0.005,
				},
			},
		});
	});
});
