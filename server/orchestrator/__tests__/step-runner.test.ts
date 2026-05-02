import { describe, expect, it } from "vitest";
import type { StepEvent } from "../../event-bus.ts";
import type { RunContext } from "../../runner/runner.ts";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, runId } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import type {
	AgentInvokeOptions,
	AgentInvoker,
	AgentMessage,
} from "../agent-invoker.ts";
import { runWorkflowSteps } from "../step-runner.ts";

const issue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	title: "Fix it",
	description: "",
	labels: [],
	url: "https://example.test",
	createdAt: "2026-01-01T00:00:00Z",
};

type ContextRecorder = {
	ctx: RunContext;
	stepEvents: StepEvent[];
	stepOutputs: { name: string; value: unknown }[];
	outputs: Record<string, unknown>;
};

function createCtx(
	initialOutputs: Record<string, unknown> = {},
): ContextRecorder {
	const stepEvents: StepEvent[] = [];
	const stepOutputs: { name: string; value: unknown }[] = [];
	const outputs: Record<string, unknown> = { ...initialOutputs };
	const ctx: RunContext = {
		runId: runId("test-run"),
		emitToolUse: () => {},
		emitStepEvent: (event) => stepEvents.push(event),
		setSessionId: () => {},
		setStepIndex: () => {},
		setStepOutput: (name, value) => {
			stepOutputs.push({ name, value });
			outputs[name] = value;
		},
		signal: new AbortController().signal,
		outputs,
	};
	return { ctx, stepEvents, stepOutputs, outputs };
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
	yield {
		type: "assistant",
		session_id: sessionId,
		// biome-ignore lint/suspicious/noExplicitAny: decouple from SDK shape
		message: { content: [] } as any,
		parent_tool_use_id: null,
		uuid: "00000000-0000-0000-0000-000000000010",
	} as AgentMessage;
}

describe("runWorkflowSteps", () => {
	it("does not pass outputFormat for an action step (no output_schema)", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
			steps: [{ name: "implement", prompt: "do it", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			agent,
			workflow,
			issue,
			attempt: 1,
			cwd: "/work",
			branch: "agent/issue-1",
			model: "test-model",
		});

		expect(agent.calls[0]?.outputFormat).toBeUndefined();
		expect(recorder.stepOutputs).toEqual([]);
	});

	it("passes outputFormat and captures structured_output for an output step", async () => {
		const recorder = createCtx();
		const structured = { title: "Hello", tags: ["a"] };
		const agent = createAgent(async function* () {
			yield {
				type: "assistant",
				session_id: "sess",
				// biome-ignore lint/suspicious/noExplicitAny: decouple from SDK shape
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000010",
			} as AgentMessage;
			yield {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "ok",
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				structured_output: structured,
				uuid: "00000000-0000-0000-0000-000000000020",
				session_id: "sess",
			} as AgentMessage;
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
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

		await runWorkflowSteps({
			ctx: recorder.ctx,
			agent,
			workflow,
			issue,
			attempt: 1,
			cwd: "/work",
			branch: "agent/issue-1",
			model: "test-model",
		});

		expect(agent.calls[0]?.outputFormat).toEqual({
			type: "json_schema",
			schema: outputSchema,
		});
		expect(recorder.stepOutputs).toEqual([
			{ name: "summarise", value: structured },
		]);
		expect(recorder.outputs["summarise"]).toEqual(structured);
		expect(recorder.stepEvents.map((e) => e.type)).toEqual([
			"step.started",
			"step.completed",
		]);
	});

	it("aborts with step.failed when result.subtype is error_max_structured_output_retries", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield {
				type: "result",
				subtype: "error_max_structured_output_retries",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: true,
				num_turns: 1,
				stop_reason: null,
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				errors: [],
				uuid: "00000000-0000-0000-0000-000000000030",
				session_id: "sess",
			} as AgentMessage;
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
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
				agent,
				workflow,
				issue,
				attempt: 1,
				cwd: "/work",
				branch: "agent/issue-1",
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
			yield {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "ok",
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				structured_output: { ignored: true },
				uuid: "00000000-0000-0000-0000-000000000040",
				session_id: "sess",
			} as AgentMessage;
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
			steps: [{ name: "implement", prompt: "do it", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			agent,
			workflow,
			issue,
			attempt: 1,
			cwd: "/work",
			branch: "agent/issue-1",
			model: "test-model",
		});

		expect(recorder.stepOutputs).toEqual([]);
		expect(recorder.stepEvents.map((e) => e.type)).toEqual([
			"step.started",
			"step.completed",
		]);
	});

	it("exposes initialOutputs on ctx.outputs throughout the run", async () => {
		const recorder = createCtx({ earlier: { x: "from-parent" } });
		let observed: Record<string, unknown> | undefined;
		const agent = createAgent(async function* (_opts) {
			observed = { ...recorder.ctx.outputs };
			yield* yieldAssistant("sess");
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
			steps: [{ name: "after", prompt: "after", resume_previous: false }],
			change_request: baseChangeRequest,
		};

		await runWorkflowSteps({
			ctx: recorder.ctx,
			agent,
			workflow,
			issue,
			attempt: 1,
			cwd: "/work",
			branch: "agent/issue-1",
			model: "test-model",
		});

		expect(observed).toEqual({ earlier: { x: "from-parent" } });
	});

	it("substitutes the branch param into a step prompt", async () => {
		const recorder = createCtx();
		const agent = createAgent(() => yieldAssistant("sess"));
		const workflow: RepoWorkflow = {
			branch: "ignored",
			base_branch: "main",
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
			agent,
			workflow,
			issue,
			attempt: 1,
			branch: "feat/proposed",
			cwd: "/work",
			model: "test-model",
		});

		expect(agent.calls[0]?.prompt).toBe("Working on feat/proposed");
	});

	it("substitutes earlier step outputs into a later step's prompt", async () => {
		const recorder = createCtx();
		const agent = createAgent(async function* () {
			yield {
				type: "assistant",
				session_id: "sess",
				// biome-ignore lint/suspicious/noExplicitAny: decouple from SDK shape
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000050",
			} as AgentMessage;
			yield {
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "ok",
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: {} as never,
				modelUsage: {},
				permission_denials: [],
				structured_output: { title: "Earlier title" },
				uuid: "00000000-0000-0000-0000-000000000051",
				session_id: "sess",
			} as AgentMessage;
		});
		const workflow: RepoWorkflow = {
			branch: "b",
			base_branch: "main",
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
			agent,
			workflow,
			issue,
			attempt: 1,
			cwd: "/work",
			branch: "agent/issue-1",
			model: "test-model",
		});

		expect(agent.calls.map((c) => c.prompt)).toEqual([
			"Summarise",
			"Use Earlier title",
		]);
	});
});
