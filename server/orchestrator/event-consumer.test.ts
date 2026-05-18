import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Queue } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as canonicalLog from "../canonical-log.ts";
import type { RunRepository } from "../run-repository.ts";
import type { EmitInput } from "../runner/runner.ts";
import { testLogger } from "../test-support/test-logger.ts";
import { runId } from "../types/brands.ts";
import type { AgentMessage } from "../workflow/agent-invoker.ts";
import type { WorkflowEvent } from "../workflow/event-emitter.ts";
import { makeWorkflowRuntime } from "../workflow/runtime.ts";
import type { StepUsage, WorkflowStep } from "../workflow/types.ts";
import { consumeWorkflowEvents } from "./event-consumer.ts";

type AssistantMessage = Extract<AgentMessage, { type: "assistant" }>;

type ConsumerRepoCalls = {
	startStep: Array<{ runId: string; index: number; startedAt: string }>;
	completeStep: Array<{
		runId: string;
		index: number;
		durationMs: number;
	}>;
	failStep: Array<{
		runId: string;
		index: number;
		durationMs: number;
		error: string;
	}>;
	writeStepOutput: Array<{ runId: string; name: string; value: unknown }>;
	addRunUsage: Array<{
		runId: string;
		usage: { costUsd: number; tokensInput: number; tokensOutput: number };
	}>;
};

function makeRepo(): {
	repo: Pick<
		RunRepository,
		| "startStep"
		| "completeStep"
		| "failStep"
		| "writeStepOutput"
		| "addRunUsage"
	>;
	calls: ConsumerRepoCalls;
} {
	const calls: ConsumerRepoCalls = {
		startStep: [],
		completeStep: [],
		failStep: [],
		writeStepOutput: [],
		addRunUsage: [],
	};
	return {
		calls,
		repo: {
			startStep: (rid, index, params) => {
				calls.startStep.push({
					runId: rid,
					index,
					startedAt: params.startedAt,
				});
			},
			completeStep: (rid, index, params) => {
				calls.completeStep.push({
					runId: rid,
					index,
					durationMs: params.durationMs,
				});
			},
			failStep: (rid, index, params) => {
				calls.failStep.push({
					runId: rid,
					index,
					durationMs: params.durationMs,
					error: params.error,
				});
			},
			writeStepOutput: (rid, name, value) => {
				calls.writeStepOutput.push({ runId: rid, name, value });
			},
			addRunUsage: (rid, usage) => {
				calls.addRunUsage.push({ runId: rid, usage });
			},
		},
	};
}

function emittedEvents(): {
	ctx: { emit: (input: EmitInput) => void };
	events: EmitInput[];
} {
	const events: EmitInput[] = [];
	return {
		events,
		ctx: { emit: (input) => events.push(input) },
	};
}

function assistant(blocks: Array<Record<string, unknown>>): AssistantMessage {
	return {
		type: "assistant",
		session_id: "session-x",
		message: { content: blocks },
	} as unknown as AssistantMessage;
}

const TEST_RUN_ID = runId("01J0000000000000000000RID0");

const emptyUsage = (): StepUsage => ({
	costUsd: 0,
	tokensInput: 0,
	tokensOutput: 0,
	modelUsage: {},
});

const step = (overrides: Partial<WorkflowStep> = {}): WorkflowStep => ({
	name: "act",
	prompt: "noop",
	resume_previous: false,
	model: "claude-sonnet-4-6",
	measure_diff: false,
	...overrides,
});

async function drive(
	events: ReadonlyArray<WorkflowEvent>,
	options: {
		steps?: WorkflowStep[];
		cwd?: string;
		emitter?: { emit: (input: EmitInput) => void };
		repo?: ReturnType<typeof makeRepo>["repo"];
	} = {},
): Promise<void> {
	const runtime = makeWorkflowRuntime();
	try {
		const queue = await runtime.runPromise(Queue.unbounded<WorkflowEvent>());
		const consumer = runtime.runPromise(
			consumeWorkflowEvents(queue, {
				runRepo: options.repo ?? makeRepo().repo,
				ctx: options.emitter ?? { emit: () => {} },
				runId: TEST_RUN_ID,
				cwd: options.cwd ?? "/workdir",
				logger: testLogger,
				steps: options.steps ?? [step()],
			}),
		);
		for (const event of events) {
			await runtime.runPromise(queue.offer(event));
		}
		await runtime.runPromise(Queue.shutdown(queue));
		await consumer;
	} finally {
		await runtime.dispose();
	}
}

async function withCanonical<T>(fn: () => Promise<T>): Promise<{
	result: T;
	bag: Record<string, unknown>;
}> {
	const captured: Record<string, unknown>[] = [];
	const log = {
		info(obj: Record<string, unknown>, _msg: string) {
			captured.push(obj);
		},
	};
	const result = await canonicalLog.run({ scope: "test" }, fn, log);
	return { result, bag: captured[0] ?? {} };
}

describe("event-consumer transcript", () => {
	it("emits agent:say for non-empty text blocks and skips whitespace-only ones", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{ type: "text", text: "  hello world  " },
						{ type: "text", text: "   " },
					]),
				},
			],
			{ emitter: ctx },
		);
		const says = events.filter((e) => e.kind === "agent:say");
		expect(says).toEqual([
			{ kind: "agent:say", stepName: "act", data: { text: "hello world" } },
		]);
	});

	it("Read tool emits tool:read with a workdir-relative path", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Read",
							input: { file_path: "/workdir/src/index.ts" },
						},
					]),
				},
			],
			{ emitter: ctx, cwd: "/workdir" },
		);
		expect(events.find((e) => e.kind === "tool:read")).toEqual({
			kind: "tool:read",
			stepName: "act",
			data: { path: "src/index.ts", lines: 0 },
		});
	});

	it("Edit / Write / MultiEdit all emit tool:edit", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Edit",
							input: { file_path: "/workdir/a.ts" },
						},
						{
							type: "tool_use",
							name: "Write",
							input: { file_path: "/workdir/b.ts" },
						},
						{
							type: "tool_use",
							name: "MultiEdit",
							input: { file_path: "/workdir/c.ts" },
						},
					]),
				},
			],
			{ emitter: ctx, cwd: "/workdir" },
		);
		expect(
			events.filter((e) => e.kind === "tool:edit").map((e) => e.data.path),
		).toEqual(["a.ts", "b.ts", "c.ts"]);
	});

	it("Grep emits tool:grep with a workdir-relative path and matches: 0", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Grep",
							input: { pattern: "TODO", path: "/workdir/src" },
						},
					]),
				},
			],
			{ emitter: ctx, cwd: "/workdir" },
		);
		expect(events.find((e) => e.kind === "tool:grep")).toEqual({
			kind: "tool:grep",
			stepName: "act",
			data: { pattern: "TODO", path: "src", matches: 0 },
		});
	});

	it("Bash emits tool:bash with state: running, exitCode null, and a command shortened against the /private prefix", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Bash",
							input: { command: "cat /private/workdir/file.txt" },
						},
					]),
				},
			],
			{ emitter: ctx, cwd: "/workdir" },
		);
		expect(events.find((e) => e.kind === "tool:bash")).toEqual({
			kind: "tool:bash",
			stepName: "act",
			data: {
				command: "cat file.txt",
				cwd: "/workdir",
				state: "running",
				exitCode: null,
			},
		});
	});

	it("unknown tools emit tool:other with summary derived from query (or other known input field)", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "WebSearch",
							input: { query: "Effect Schema" },
						},
					]),
				},
			],
			{ emitter: ctx },
		);
		expect(events.find((e) => e.kind === "tool:other")).toEqual({
			kind: "tool:other",
			stepName: "act",
			data: { tool: "WebSearch", summary: "Effect Schema" },
		});
	});

	it("Agent tool summary uses description, not prompt", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Agent",
							input: {
								description: "summarise file",
								prompt: "the full prompt text",
							},
						},
					]),
				},
			],
			{ emitter: ctx },
		);
		expect(events.find((e) => e.kind === "tool:other")).toEqual({
			kind: "tool:other",
			stepName: "act",
			data: { tool: "Agent", summary: "summarise file" },
		});
	});

	it("Skill tool summary uses the skill name", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Skill",
							input: { skill: "tdd" },
						},
					]),
				},
			],
			{ emitter: ctx },
		);
		expect(events.find((e) => e.kind === "tool:other")).toEqual({
			kind: "tool:other",
			stepName: "act",
			data: { tool: "Skill", summary: "tdd" },
		});
	});

	it("StructuredOutput emits no transcript event", async () => {
		const { ctx, events } = emittedEvents();
		await drive(
			[
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "StructuredOutput",
							input: { value: { ok: true } },
						},
					]),
				},
			],
			{ emitter: ctx },
		);
		expect(events.some((e) => e.kind.startsWith("tool:"))).toBe(false);
	});
});

describe("event-consumer canonical log", () => {
	it("aggregates tool_use_by_name across assistant messages", async () => {
		const { bag } = await withCanonical(async () => {
			await drive([
				{
					_tag: "StepAssistantMessage",
					stepName: "act",
					message: assistant([
						{
							type: "tool_use",
							name: "Read",
							input: { file_path: "/workdir/a.ts" },
						},
						{
							type: "tool_use",
							name: "Read",
							input: { file_path: "/workdir/b.ts" },
						},
						{
							type: "tool_use",
							name: "Edit",
							input: { file_path: "/workdir/c.ts" },
						},
					]),
				},
			]);
		});
		expect(bag["tool_use_by_name"]).toEqual({ Read: 2, Edit: 1 });
	});

	it("aggregates usage onto the bag from StepResult events", async () => {
		const { bag } = await withCanonical(async () => {
			await drive(
				[
					{
						_tag: "StepStarted",
						name: "act",
						index: 1,
						total: 1,
					},
					{
						_tag: "StepResult",
						stepName: "act",
						structuredOutput: { value: "out" },
						sessionId: "s1",
						usage: {
							costUsd: 0.05,
							tokensInput: 100,
							tokensOutput: 40,
							modelUsage: {
								"claude-sonnet-4-6": {
									inputTokens: 100,
									outputTokens: 40,
									costUSD: 0.05,
								},
							},
						},
					},
					{
						_tag: "StepCompleted",
						stepName: "act",
						index: 1,
						durationMs: 1234,
					},
				],
				{ steps: [step({ name: "act" })] },
			);
		});
		expect(bag).toMatchObject({
			steps_total: 1,
			steps_completed: 1,
			total_cost_usd: 0.05,
			total_input_tokens: 100,
			total_output_tokens: 40,
			models_used: {
				"claude-sonnet-4-6": {
					input_tokens: 100,
					output_tokens: 40,
					cost_usd: 0.05,
				},
			},
			step_durations_ms: { act: 1234 },
			step_outputs_collected: ["act"],
		});
	});

	it("records failed_step on StepFailed", async () => {
		const { bag } = await withCanonical(async () => {
			await drive(
				[
					{
						_tag: "StepStarted",
						name: "act",
						index: 1,
						total: 1,
					},
					{
						_tag: "StepFailed",
						stepName: "act",
						index: 1,
						error: {
							_tag: "AgentTurnError",
							message: "boom",
						} as unknown as Extract<
							WorkflowEvent,
							{ _tag: "StepFailed" }
						>["error"],
						durationMs: 100,
					},
				],
				{ steps: [step({ name: "act" })] },
			);
		});
		expect(bag["failed_step"]).toEqual({
			name: "act",
			index: 1,
			error: "boom",
		});
	});
});

describe("event-consumer repository writes", () => {
	it("writes startStep / completeStep / addRunUsage / writeStepOutput for an output step", async () => {
		const { repo, calls } = makeRepo();
		await drive(
			[
				{ _tag: "StepStarted", name: "act", index: 1, total: 1 },
				{
					_tag: "StepResult",
					stepName: "act",
					structuredOutput: { value: 42 },
					sessionId: "s1",
					usage: {
						costUsd: 0.01,
						tokensInput: 5,
						tokensOutput: 1,
						modelUsage: {},
					},
				},
				{
					_tag: "StepCompleted",
					stepName: "act",
					index: 1,
					durationMs: 250,
				},
			],
			{ repo, steps: [step({ name: "act" })] },
		);
		expect(calls.startStep).toHaveLength(1);
		expect(calls.completeStep).toEqual([
			{ runId: TEST_RUN_ID, index: 1, durationMs: 250 },
		]);
		expect(calls.failStep).toEqual([]);
		expect(calls.addRunUsage).toEqual([
			{
				runId: TEST_RUN_ID,
				usage: {
					costUsd: 0.01,
					tokensInput: 5,
					tokensOutput: 1,
					modelUsage: {},
				},
			},
		]);
		expect(calls.writeStepOutput).toEqual([
			{ runId: TEST_RUN_ID, name: "act", value: { value: 42 } },
		]);
	});

	it("does not call writeStepOutput when StepResult has no structuredOutput", async () => {
		const { repo, calls } = makeRepo();
		await drive(
			[
				{ _tag: "StepStarted", name: "act", index: 1, total: 1 },
				{
					_tag: "StepResult",
					stepName: "act",
					sessionId: "s1",
					usage: emptyUsage(),
				},
				{
					_tag: "StepCompleted",
					stepName: "act",
					index: 1,
					durationMs: 10,
				},
			],
			{ repo, steps: [step({ name: "act" })] },
		);
		expect(calls.writeStepOutput).toEqual([]);
	});

	it("writes failStep with the error message on StepFailed", async () => {
		const { repo, calls } = makeRepo();
		await drive(
			[
				{ _tag: "StepStarted", name: "act", index: 1, total: 1 },
				{
					_tag: "StepFailed",
					stepName: "act",
					index: 1,
					error: {
						_tag: "AgentTurnError",
						message: "subtype error_max_structured_output_retries",
					} as unknown as Extract<
						WorkflowEvent,
						{ _tag: "StepFailed" }
					>["error"],
					durationMs: 33,
				},
			],
			{ repo, steps: [step({ name: "act" })] },
		);
		expect(calls.failStep).toEqual([
			{
				runId: TEST_RUN_ID,
				index: 1,
				durationMs: 33,
				error: "subtype error_max_structured_output_retries",
			},
		]);
	});
});

describe("event-consumer measure_diff", () => {
	let repoPath: string;

	beforeEach(() => {
		repoPath = mkdtempSync(join(tmpdir(), "event-consumer-diff-"));
		const run = (...args: string[]) =>
			execFileSync("git", args, { cwd: repoPath });
		run("init", "-q");
		run("config", "user.email", "t@t.test");
		run("config", "user.name", "t");
		run("commit", "--allow-empty", "-m", "base");
	});

	afterEach(() => {
		execFileSync("rm", ["-rf", repoPath]);
	});

	it("calls the diff command after StepCompleted for steps with measure_diff: true", async () => {
		writeFileSync(join(repoPath, "a.txt"), "hi\n");
		execFileSync("git", ["add", "."], { cwd: repoPath });
		execFileSync("git", ["commit", "-m", "change"], { cwd: repoPath });

		await drive(
			[
				{ _tag: "StepStarted", name: "act", index: 1, total: 1 },
				{
					_tag: "StepResult",
					stepName: "act",
					sessionId: "s1",
					usage: emptyUsage(),
				},
				{
					_tag: "StepCompleted",
					stepName: "act",
					index: 1,
					durationMs: 10,
				},
			],
			{
				cwd: repoPath,
				steps: [step({ name: "act", measure_diff: true })],
			},
		);
		// The consumer ran without throwing — a smoke test that the diff path is
		// exercised end-to-end against a real repo. Span attribute assertions are
		// covered by parse-shortstat unit tests.
	});

	it("skips git commands entirely for steps without measure_diff", async () => {
		await drive(
			[
				{ _tag: "StepStarted", name: "act", index: 1, total: 1 },
				{
					_tag: "StepCompleted",
					stepName: "act",
					index: 1,
					durationMs: 5,
				},
			],
			{
				cwd: "/this/path/does/not/exist",
				steps: [step({ name: "act", measure_diff: false })],
			},
		);
		// no throw despite invalid cwd — measure_diff: false means git is never invoked
	});
});
