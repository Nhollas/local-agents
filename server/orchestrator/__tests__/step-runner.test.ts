import { describe, expect, it } from "vitest";
import * as canonicalLog from "../../canonical-log.ts";
import type { StepEvent } from "../../event-bus.ts";
import type { RunRepository } from "../../run-repository.ts";
import type { RunContext } from "../../runner/runner.ts";
import {
	buildAssistantMessage,
	buildErrorResult,
	buildSuccessResult,
} from "../../testing/support/agent-messages.ts";
import type { Issue } from "../../trackers/types.ts";
import {
	issueKey,
	issueNumber,
	type RunId,
	repoSlug,
	runId,
} from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import type {
	AgentInvokeOptions,
	AgentInvoker,
	AgentMessage,
} from "../agent-invoker.ts";
import { runWorkflowSteps } from "../step-runner.ts";

type StepCostFields = {
	model: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
};

function resultMessage(uuid: string, fields: StepCostFields): AgentMessage {
	return buildSuccessResult({
		uuid,
		totalCostUsd: fields.costUsd,
		modelUsage: {
			[fields.model]: {
				inputTokens: fields.inputTokens,
				outputTokens: fields.outputTokens,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				webSearchRequests: 0,
				costUSD: fields.costUsd,
				contextWindow: 200_000,
				maxOutputTokens: 8_000,
			},
		},
	});
}

function captureBag(): {
	logger: { info(obj: Record<string, unknown>, msg: string): void };
	bag: () => Record<string, unknown>;
} {
	let captured: Record<string, unknown> = {};
	return {
		logger: {
			info(obj: Record<string, unknown>) {
				captured = obj;
			},
		},
		bag: () => captured,
	};
}

const issue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	repo: repoSlug("owner/repo"),
	title: "Fix it",
	description: "",
	labels: [],
	url: "https://example.test",
	createdAt: "2026-01-01T00:00:00Z",
};

type ContextRecorder = {
	ctx: RunContext;
	runRepo: Pick<RunRepository, "writeStepOutput">;
	stepEvents: StepEvent[];
	stepOutputs: { runId: RunId; name: string; value: unknown }[];
};

function createCtx(): ContextRecorder {
	const stepEvents: StepEvent[] = [];
	const stepOutputs: { runId: RunId; name: string; value: unknown }[] = [];
	const ctx: RunContext = {
		runId: runId("test-run"),
		emitToolUse: () => {},
		emitStepEvent: (event) => stepEvents.push(event),
		signal: new AbortController().signal,
	};
	const runRepo: Pick<RunRepository, "writeStepOutput"> = {
		writeStepOutput: (id, name, value) => {
			stepOutputs.push({ runId: id, name, value });
		},
	};
	return { ctx, runRepo, stepEvents, stepOutputs };
}

type ScriptedCall = AgentInvokeOptions;

function createAgent(
	script: (call: ScriptedCall) => AsyncIterable<AgentMessage>,
): AgentInvoker & { calls: ScriptedCall[] } {
	const calls: ScriptedCall[] = [];
	return {
		calls,
		invoke(opts) {
			calls.push(opts);
			return script(opts);
		},
	};
}

const baseChangeRequest = { title: "t", body: "b" };

const outputSchema = {
	type: "object",
	properties: { title: { type: "string" } },
	required: ["title"],
};

async function* yieldAssistant(sessionId: string): AsyncIterable<AgentMessage> {
	yield buildAssistantMessage({
		uuid: "00000000-0000-0000-0000-000000000010",
		sessionId,
	});
}

describe("runWorkflowSteps", () => {
	it("does not pass outputFormat for an action step (no output_schema)", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [{ name: "implement", prompt: "do it", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		const outputs = await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			cwd: "/work",
			branch: "agent/issue-1",
			baseBranch: "main",
			model: "test-model",
		});

		expect(agent.calls[0]?.outputFormat).toBeUndefined();
		expect(recorder.stepOutputs).toEqual([]);
		expect(outputs).toEqual({});
	});

	it("passes outputFormat, persists structured_output, and returns outputs", async () => {
		const recorder = createCtx();
		const structured = { title: "Hello", tags: ["a"] };
		const agent = createAgent(async function* () {
			yield buildAssistantMessage({
				uuid: "00000000-0000-0000-0000-000000000010",
			});
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000020",
				structuredOutput: structured,
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{
					name: "summarise",
					prompt: "Summarise",
					resume_previous: false,
					output_schema: outputSchema,
				},
			],
			change_request: baseChangeRequest,
		};

		const outputs = await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			cwd: "/work",
			branch: "agent/issue-1",
			baseBranch: "main",
			model: "test-model",
		});

		expect(agent.calls[0]?.outputFormat).toEqual({
			type: "json_schema",
			schema: outputSchema,
		});
		expect(recorder.stepOutputs).toEqual([
			{ runId: recorder.ctx.runId, name: "summarise", value: structured },
		]);
		expect(outputs).toEqual({ summarise: structured });
		expect(recorder.stepEvents.map((e) => e.type)).toEqual([
			"step.started",
			"step.completed",
		]);
	});

	it("aborts with step.failed when result.subtype is error_max_structured_output_retries", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield buildErrorResult({
				uuid: "00000000-0000-0000-0000-000000000030",
				subtype: "error_max_structured_output_retries",
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{
					name: "summarise",
					prompt: "Summarise",
					resume_previous: false,
					output_schema: outputSchema,
				},
				{ name: "after", prompt: "after", resume_previous: false },
			],
			change_request: baseChangeRequest,
		};

		await expect(
			runWorkflowSteps({
				ctx: recorder.ctx,
				runRepo: recorder.runRepo,
				agent,
				workflow,
				issue,
				cwd: "/work",
				branch: "agent/issue-1",
				baseBranch: "main",
				model: "test-model",
			}),
		).rejects.toThrow(/error_max_structured_output_retries/);

		expect(agent.calls).toHaveLength(1);
		expect(recorder.stepEvents.map((e) => e.type)).toEqual([
			"step.started",
			"step.failed",
		]);
		expect(recorder.stepOutputs).toEqual([]);
	});

	it("ignores a result.success message on an action step (no output_schema)", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield* yieldAssistant("sess");
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000040",
				structuredOutput: { ignored: true },
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [{ name: "implement", prompt: "do it", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			cwd: "/work",
			branch: "agent/issue-1",
			baseBranch: "main",
			model: "test-model",
		});

		expect(recorder.stepOutputs).toEqual([]);
		expect(recorder.stepEvents.map((e) => e.type)).toEqual([
			"step.started",
			"step.completed",
		]);
	});

	it("substitutes the branch param into a step prompt", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "ignored",
			steps: [
				{
					name: "implement",
					prompt: "Working on {{ branch }}",
					resume_previous: false,
				},
			],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			branch: "feat/proposed",
			cwd: "/work",
			baseBranch: "main",
			model: "test-model",
		});

		expect(agent.calls[0]?.prompt).toBe("Working on feat/proposed");
	});

	it("substitutes earlier step outputs into a later step's prompt", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield buildAssistantMessage({
				uuid: "00000000-0000-0000-0000-000000000050",
			});
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000051",
				structuredOutput: { title: "Earlier title" },
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{
					name: "summarise",
					prompt: "Summarise",
					resume_previous: false,
					output_schema: outputSchema,
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
				},
			],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			cwd: "/work",
			branch: "agent/issue-1",
			baseBranch: "main",
			model: "test-model",
		});

		expect(agent.calls.map((c) => c.prompt)).toEqual([
			"Summarise",
			"Use Earlier title",
		]);
	});

	it("flushes step counters and durations into the canonical log", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{ name: "implement", prompt: "do it", resume_previous: false },
				{ name: "summarise", prompt: "summarise", resume_previous: false },
			],
			change_request: baseChangeRequest,
		};

		const { logger, bag } = captureBag();
		await canonicalLog.run(
			{ scope: "run" },
			() =>
				runWorkflowSteps({
					ctx: recorder.ctx,
					runRepo: recorder.runRepo,
					agent,
					workflow,
					issue,
					cwd: "/work",
					branch: "agent/issue-1",
					baseBranch: "main",
					model: "test-model",
				}),
			logger,
		);

		const result = bag();
		expect(result["steps_total"]).toBe(2);
		expect(result["steps_completed"]).toBe(2);
		const durations = result["step_durations_ms"] as Record<string, number>;
		expect(Object.keys(durations).sort()).toEqual(["implement", "summarise"]);
		expect(durations["implement"]).toEqual(expect.any(Number));
		expect(durations["summarise"]).toEqual(expect.any(Number));
	});

	it("collects step output names without persisting payloads to the bag", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield* yieldAssistant("sess");
			yield buildSuccessResult({
				uuid: "00000000-0000-0000-0000-000000000081",
				structuredOutput: { title: "Hello" },
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{
					name: "summarise",
					prompt: "summarise",
					resume_previous: false,
					output_schema: outputSchema,
				},
			],
			change_request: baseChangeRequest,
		};

		const { logger, bag } = captureBag();
		await canonicalLog.run(
			{ scope: "run" },
			() =>
				runWorkflowSteps({
					ctx: recorder.ctx,
					runRepo: recorder.runRepo,
					agent,
					workflow,
					issue,
					cwd: "/work",
					branch: "agent/issue-1",
					baseBranch: "main",
					model: "test-model",
				}),
			logger,
		);

		expect(bag()["step_outputs_collected"]).toEqual(["summarise"]);
		expect(bag()).not.toHaveProperty("step_outputs");
		expect(bag()).not.toHaveProperty("step_events");
	});

	it("sets failed_step on the canonical bag when a step throws", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield buildErrorResult({
				uuid: "00000000-0000-0000-0000-000000000090",
				subtype: "error_max_turns",
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{ name: "implement", prompt: "do it", resume_previous: false },
				{ name: "after", prompt: "after", resume_previous: false },
			],
			change_request: baseChangeRequest,
		};

		const { logger, bag } = captureBag();
		await expect(
			canonicalLog.run(
				{ scope: "run" },
				() =>
					runWorkflowSteps({
						ctx: recorder.ctx,
						runRepo: recorder.runRepo,
						agent,
						workflow,
						issue,
						cwd: "/work",
						branch: "agent/issue-1",
						baseBranch: "main",
						model: "test-model",
					}),
				logger,
			),
		).rejects.toThrow(/error_max_turns/);

		expect(bag()["failed_step"]).toEqual({
			name: "implement",
			index: 0,
			error: "error_max_turns",
		});
		expect(bag()["steps_total"]).toBe(2);
		expect(bag()["steps_completed"]).toBe(0);
	});

	it("aggregates cost and token usage into the canonical log", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* (opts) {
			yield* yieldAssistant("sess");
			if (opts.model === "claude-sonnet-4-6") {
				yield resultMessage("00000000-0000-0000-0000-000000000060", {
					model: "claude-sonnet-4-6",
					costUsd: 0.05,
					inputTokens: 1000,
					outputTokens: 200,
				});
			} else {
				yield resultMessage("00000000-0000-0000-0000-000000000061", {
					model: "claude-haiku-4-5",
					costUsd: 0.01,
					inputTokens: 500,
					outputTokens: 100,
				});
			}
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{ name: "implement", prompt: "do it", resume_previous: false },
				{
					name: "summarise",
					prompt: "summarise",
					resume_previous: false,
					model: "claude-haiku-4-5",
				},
			],
			change_request: baseChangeRequest,
		};

		const { logger, bag } = captureBag();
		await canonicalLog.run(
			{ scope: "run" },
			() =>
				runWorkflowSteps({
					ctx: recorder.ctx,
					runRepo: recorder.runRepo,
					agent,
					workflow,
					issue,
					cwd: "/work",
					branch: "agent/issue-1",
					baseBranch: "main",
					model: "claude-sonnet-4-6",
				}),
			logger,
		);

		const result = bag();
		expect(result["total_cost_usd"]).toBeCloseTo(0.06, 6);
		expect(result["total_input_tokens"]).toBe(1500);
		expect(result["total_output_tokens"]).toBe(300);
		expect(result["models_used"]).toEqual({
			"claude-sonnet-4-6": {
				input_tokens: 1000,
				output_tokens: 200,
				cost_usd: 0.05,
			},
			"claude-haiku-4-5": {
				input_tokens: 500,
				output_tokens: 100,
				cost_usd: 0.01,
			},
		});
	});

	it("flushes accumulated cost even when a step fails", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield* yieldAssistant("sess");
			yield buildErrorResult({
				uuid: "00000000-0000-0000-0000-000000000070",
				subtype: "error_max_turns",
				totalCostUsd: 0.04,
				modelUsage: {
					"claude-sonnet-4-6": {
						inputTokens: 800,
						outputTokens: 150,
						cacheReadInputTokens: 0,
						cacheCreationInputTokens: 0,
						webSearchRequests: 0,
						costUSD: 0.04,
						contextWindow: 200_000,
						maxOutputTokens: 8_000,
					},
				},
			});
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [{ name: "implement", prompt: "do it", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		const { logger, bag } = captureBag();
		await expect(
			canonicalLog.run(
				{ scope: "run" },
				() =>
					runWorkflowSteps({
						ctx: recorder.ctx,
						runRepo: recorder.runRepo,
						agent,
						workflow,
						issue,
						cwd: "/work",
						branch: "agent/issue-1",
						baseBranch: "main",
						model: "claude-sonnet-4-6",
					}),
				logger,
			),
		).rejects.toThrow(/error_max_turns/);

		expect(bag()).toEqual(
			expect.objectContaining({
				total_cost_usd: 0.04,
				total_input_tokens: 800,
				total_output_tokens: 150,
			}),
		);
	});

	it("uses the per-step model when set, otherwise the default model", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "b",
			steps: [
				{ name: "implement", prompt: "do it", resume_previous: false },
				{
					name: "review",
					prompt: "review it",
					resume_previous: false,
					model: "claude-opus-4-7",
				},
			],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			runRepo: recorder.runRepo,
			agent,
			workflow,
			issue,
			cwd: "/work",
			branch: "agent/issue-1",
			baseBranch: "main",
			model: "claude-sonnet-4-6",
		});

		expect(agent.calls.map((c) => c.model)).toEqual([
			"claude-sonnet-4-6",
			"claude-opus-4-7",
		]);
	});
});
