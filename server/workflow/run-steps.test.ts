import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Effect, Layer, Queue } from "effect";
import { describe, expect, it } from "vitest";
import { issueKey, issueNumber } from "../types/brands.ts";
import {
	type AgentInvokeOptions,
	AgentInvoker,
	type AgentInvokerService,
	type AgentMessage,
} from "./agent-invoker.ts";
import { type WorkflowEvent, WorkflowEventEmitter } from "./event-emitter.ts";
import { runSteps } from "./run-steps.ts";
import type { PromptScope, WorkflowStep } from "./types.ts";

const PlatformLayer = Layer.merge(
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
);

const scope: PromptScope = {
	issue: {
		key: issueKey("TEST-7"),
		number: issueNumber(7),
		title: "Add widget",
		description: "Add widgets to the dashboard.",
		labels: [],
		url: "https://tracker.example.test/TEST-7",
		createdAt: "2026-01-01T00:00:00.000Z",
	},
	baseBranch: "main",
};

const cwd = "/tmp";

const outputSchema = {
	type: "object",
	properties: { value: { type: "string" } },
	required: ["value"],
} as const;

type RecordedCall = {
	prompt: string;
	model: string;
	hasSchema: boolean;
	allowedTools: readonly string[] | undefined;
	resumeSessionId: string | undefined;
	env: Record<string, string> | undefined;
};

type StubResponse = (call: RecordedCall) => AgentMessage[];

function stubInvoker(
	respond: StubResponse,
	recording: { calls: RecordedCall[] } = { calls: [] },
): AgentInvokerService {
	return {
		invoke(opts: AgentInvokeOptions) {
			const call: RecordedCall = {
				prompt: opts.prompt,
				model: opts.model,
				hasSchema: opts.outputFormat != null,
				allowedTools: opts.allowedTools,
				resumeSessionId: opts.resumeSessionId,
				env: opts.env,
			};
			recording.calls.push(call);
			const messages = respond(call);
			return Effect.succeed(
				(async function* () {
					for (const msg of messages) yield msg;
				})(),
			);
		},
	};
}

function resultMessage(overrides: {
	subtype: "success" | "error_max_structured_output_retries";
	sessionId?: string;
	structured_output?: unknown;
	modelUsage?: Record<
		string,
		{ inputTokens: number; outputTokens: number; costUSD: number }
	>;
	total_cost_usd?: number;
}): AgentMessage {
	const base = {
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
		session_id: overrides.sessionId ?? "session-default",
	};
	if (overrides.subtype === "success") {
		return {
			...base,
			subtype: "success",
			structured_output: overrides.structured_output,
		} as unknown as AgentMessage;
	}
	return {
		...base,
		subtype: overrides.subtype,
		errors: [],
	} as unknown as AgentMessage;
}

function runRunSteps(
	steps: readonly WorkflowStep[],
	invoker: AgentInvokerService,
	branch = "agent/widget",
	env?: Record<string, string>,
) {
	return Effect.gen(function* () {
		const queue = yield* Queue.unbounded<WorkflowEvent>();
		const layers = Layer.mergeAll(
			Layer.succeed(AgentInvoker, AgentInvoker.make(invoker)),
			WorkflowEventEmitter.Default(queue),
		);
		const result = yield* Effect.either(
			runSteps(steps, scope, branch, cwd, env).pipe(Effect.provide(layers)),
		);
		const events = yield* Queue.takeAll(queue);
		return { result, events: [...events] };
	}).pipe(Effect.provide(PlatformLayer));
}

const actionStep = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
	name: "act",
	prompt: "do the thing for {{ issue.key }}",
	resume_previous: false,
	model: "claude-sonnet-4-6",
	measure_diff: false,
	...overrides,
});

const outputStep = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
	name: "decide",
	prompt: "produce output for {{ issue.key }}",
	resume_previous: false,
	model: "claude-sonnet-4-6",
	measure_diff: false,
	output_schema: outputSchema,
	...overrides,
});

describe("runSteps", () => {
	it("action step does not pass outputSchema and ignores structured_output on the result", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [
				resultMessage({
					subtype: "success",
					structured_output: { ignored: "yes" },
				}),
			],
			recording,
		);
		const { result, events } = await Effect.runPromise(
			runRunSteps([actionStep()], invoker),
		);
		if (result._tag !== "Right") throw new Error("expected success");
		expect(result.right).toEqual({});
		expect(recording.calls[0]?.hasSchema).toBe(false);
		const stepResult = events.find((e) => e._tag === "StepResult");
		expect(stepResult).toEqual({
			_tag: "StepResult",
			stepName: "act",
			sessionId: "session-default",
			usage: { costUsd: 0, tokensInput: 0, tokensOutput: 0, modelUsage: {} },
		});
	});

	it("output step passes the schema, returns the decoded output, and includes it on StepResult", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [
				resultMessage({
					subtype: "success",
					structured_output: { value: "decoded" },
				}),
			],
			recording,
		);
		const { result, events } = await Effect.runPromise(
			runRunSteps([outputStep()], invoker),
		);
		if (result._tag !== "Right") throw new Error("expected success");
		expect(result.right).toEqual({ decide: { value: "decoded" } });
		expect(recording.calls[0]?.hasSchema).toBe(true);
		const stepResult = events.find((e) => e._tag === "StepResult");
		if (stepResult?._tag !== "StepResult") throw new Error("no StepResult");
		expect(stepResult.structuredOutput).toEqual({ value: "decoded" });
	});

	it("error_max_structured_output_retries aborts the loop with StructuredOutputDecodeError context: step and skips subsequent steps", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [
				resultMessage({
					subtype: "error_max_structured_output_retries",
					modelUsage: {
						"claude-sonnet-4-6": {
							inputTokens: 11,
							outputTokens: 22,
							costUSD: 0.05,
						},
					},
					total_cost_usd: 0.05,
				}),
			],
			recording,
		);
		const { result, events } = await Effect.runPromise(
			runRunSteps(
				[outputStep({ name: "first" }), outputStep({ name: "second" })],
				invoker,
			),
		);
		expect(recording.calls.length).toBe(1);
		if (result._tag !== "Left") throw new Error("expected failure");
		expect(result.left._tag).toBe("StructuredOutputDecodeError");
		if (result.left._tag !== "StructuredOutputDecodeError") return;
		expect(result.left.context).toBe("step");

		const stepResult = events.find((e) => e._tag === "StepResult");
		if (stepResult?._tag !== "StepResult") throw new Error("no StepResult");
		expect(stepResult.usage.costUsd).toBe(0.05);

		const failed = events.find((e) => e._tag === "StepFailed");
		if (failed?._tag !== "StepFailed") throw new Error("no StepFailed");
		expect(failed.stepName).toBe("first");
		expect(failed.error._tag).toBe("StructuredOutputDecodeError");
		expect(events.some((e) => e._tag === "StepCompleted")).toBe(false);
	});

	it("{{ branch }} substitutes into the step prompt", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [resultMessage({ subtype: "success" })],
			recording,
		);
		await Effect.runPromise(
			runRunSteps(
				[actionStep({ prompt: "branch is {{ branch }}" })],
				invoker,
				"agent/feature",
			),
		);
		expect(recording.calls[0]?.prompt).toBe("branch is agent/feature");
	});

	it("{{ steps.<name>.output.<field> }} resolves against an earlier step's structured output", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker((call) => {
			if (call.prompt.includes("first")) {
				return [
					resultMessage({
						subtype: "success",
						structured_output: { value: "from-first" },
					}),
				];
			}
			return [resultMessage({ subtype: "success" })];
		}, recording);
		await Effect.runPromise(
			runRunSteps(
				[
					outputStep({ name: "first", prompt: "first" }),
					actionStep({
						name: "second",
						prompt: "second sees {{ steps.first.output.value }}",
					}),
				],
				invoker,
			),
		);
		expect(recording.calls[1]?.prompt).toBe("second sees from-first");
	});

	it("env propagates into each invoker call", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [resultMessage({ subtype: "success" })],
			recording,
		);
		await Effect.runPromise(
			runRunSteps([actionStep()], invoker, "agent/widget", { FOO: "bar" }),
		);
		expect(recording.calls[0]?.env).toEqual({ FOO: "bar" });
	});

	it("allowed_tools is forwarded when present and absent otherwise", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [resultMessage({ subtype: "success" })],
			recording,
		);
		await Effect.runPromise(
			runRunSteps(
				[
					actionStep({ name: "with_tools", allowed_tools: ["Read", "Write"] }),
					actionStep({ name: "without" }),
				],
				invoker,
			),
		);
		expect(recording.calls[0]?.allowedTools).toEqual(["Read", "Write"]);
		expect(recording.calls[1]?.allowedTools).toBeUndefined();
	});

	it("per-step model is passed through unchanged", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker(
			() => [resultMessage({ subtype: "success" })],
			recording,
		);
		await Effect.runPromise(
			runRunSteps(
				[
					actionStep({ name: "sonnet", model: "claude-sonnet-4-6" }),
					actionStep({ name: "haiku", model: "claude-haiku-4-5" }),
				],
				invoker,
			),
		);
		expect(recording.calls.map((c) => c.model)).toEqual([
			"claude-sonnet-4-6",
			"claude-haiku-4-5",
		]);
	});

	it("aggregates per-model usage from a multi-model result onto StepResult", async () => {
		const invoker = stubInvoker(() => [
			resultMessage({
				subtype: "success",
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
			runRunSteps([actionStep()], invoker),
		);
		const stepResult = events.find((e) => e._tag === "StepResult");
		if (stepResult?._tag !== "StepResult") throw new Error("no StepResult");
		expect(stepResult.usage).toEqual({
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

	it("event sequence for a successful step is StepStarted -> StepResult -> StepCompleted", async () => {
		const invoker = stubInvoker(() => [resultMessage({ subtype: "success" })]);
		const { events } = await Effect.runPromise(
			runRunSteps([actionStep()], invoker),
		);
		expect(events.map((e) => e._tag)).toEqual([
			"StepStarted",
			"StepResult",
			"StepCompleted",
		]);
	});

	it("resume_previous threads the prior step's sessionId into the next invoker call", async () => {
		const recording = { calls: [] as RecordedCall[] };
		const invoker = stubInvoker((call) => {
			const id = recording.calls.length === 1 ? "session-1" : "session-2";
			void call;
			return [resultMessage({ subtype: "success", sessionId: id })];
		}, recording);
		await Effect.runPromise(
			runRunSteps(
				[
					actionStep({ name: "first" }),
					actionStep({ name: "second", resume_previous: true }),
					actionStep({ name: "third" }),
				],
				invoker,
			),
		);
		expect(recording.calls[0]?.resumeSessionId).toBeUndefined();
		expect(recording.calls[1]?.resumeSessionId).toBe("session-1");
		expect(recording.calls[2]?.resumeSessionId).toBeUndefined();
	});
});
