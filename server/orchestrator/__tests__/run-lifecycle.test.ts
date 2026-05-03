import { execFile } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runStepOutputs, runs } from "../../db/schema.ts";
import { getEvents } from "../../testing/support/test-db.ts";
import {
	createInMemoryCodeHost,
	createInMemoryTracker,
	createScriptedAgent,
	createTestIssue,
	createTestRunLifecycle,
	silentAgent,
	TEST_REPO,
	yieldAssistant,
} from "../../testing/support/test-lifecycle.ts";
import { issueNumber } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

const exec = promisify(execFile);

const baseChangeRequest = {
	title: "{{ issue.title }}",
	body: "Closes {{ issue.key }}",
};

const baseWorkflow: RepoWorkflow = {
	branch: "agent/issue-{{ issue.number }}",
	base_branch: "main",
	steps: [
		{
			name: "implement",
			prompt: "Fix issue {{ issue.number }}: {{ issue.title }}",
			resume_previous: false,
		},
	],
	change_request: baseChangeRequest,
};

const multiStepWorkflow: RepoWorkflow = {
	branch: "agent/issue-{{ issue.number }}",
	base_branch: "main",
	steps: [
		{ name: "plan", prompt: "Plan {{ issue.number }}", resume_previous: false },
		{
			name: "implement",
			prompt: "Implement {{ issue.title }}",
			resume_previous: true,
		},
	],
	change_request: baseChangeRequest,
};

async function writeSetupScript(
	wsPath: string,
	contents: string,
): Promise<void> {
	const dir = join(wsPath, ".agent");
	await mkdir(dir, { recursive: true });
	const scriptPath = join(dir, "setup.sh");
	await writeFile(scriptPath, contents);
	await chmod(scriptPath, 0o755);
}

describe("RunLifecycle.dispatch", () => {
	it("happy path: clones, creates branch, runs steps, opens PR, transitions, cleans up", async () => {
		await using setup = await createTestRunLifecycle({
			agent: createScriptedAgent(() => yieldAssistant("sess-final")),
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});

		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(setup.codeHost.changeRequests).toEqual([
			{
				repo: TEST_REPO,
				head: "agent/issue-1",
				base: "main",
				title: issue.title,
				body: `Closes ${issue.key}`,
			},
		]);
		expect(setup.tracker.transitions).toEqual([
			{
				repo: TEST_REPO,
				number: issue.number,
				from: "running",
				to: "awaiting_review",
			},
		]);

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "completed",
		});

		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).rejects.toThrow();
	});

	it("step failure: workspace removed, no tracker transition, issue marked failed", async () => {
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("step exploded");
		});
		await using setup = await createTestRunLifecycle({
			agent: explodingAgent,
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "failed", error: "step exploded" });
		expect(setup.tracker.transitions).toEqual([]);
		expect(setup.tracker.failedIssues).toEqual([
			{ repo: TEST_REPO, number: issue.number },
		]);
		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).rejects.toThrow();
	});

	it("step failure: markFailed throws is swallowed, run still resolves as failed", async () => {
		const tracker = createInMemoryTracker(createTestIssue());
		tracker.failMarkFailed();
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("step exploded");
		});

		await using setup = await createTestRunLifecycle({
			agent: explodingAgent,
			tracker,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "failed", error: "step exploded" });
		expect(tracker.failedIssues).toEqual([]);
	});

	it("PR creation failure: tracker transition still attempted, run still completes", async () => {
		const tracker = createInMemoryTracker(createTestIssue());
		const codeHost = createInMemoryCodeHost("file:///dummy");
		codeHost.failChangeRequest();

		await using setup = await createTestRunLifecycle({ tracker, codeHost });
		const realCloneUrl = setup.bareRepo;
		codeHost.cloneUrl = () => realCloneUrl;

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(tracker.transitions).toEqual([
			{
				repo: TEST_REPO,
				number: issueNumber(1),
				from: "running",
				to: "awaiting_review",
			},
		]);
	});

	it("abort mid-step: result is failed with abort error, workspace kept", async () => {
		let releaseAbortable: () => void = () => {};
		const abortableAgent = createScriptedAgent(async function* (opts) {
			yield* (async function* (): AsyncGenerator<never> {
				await new Promise<void>((resolve) => {
					releaseAbortable = resolve;
					opts.signal.addEventListener("abort", () => resolve());
				});
				if (opts.signal.aborted) throw new Error("step saw abort");
			})();
		});
		await using setup = await createTestRunLifecycle({
			agent: abortableAgent,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});

		await new Promise<void>((resolve) => {
			const tick = () => {
				if (releaseAbortable !== (() => {})) resolve();
				else setTimeout(tick, 5);
			};
			tick();
		});

		const killed = setup.runner.kill(handle.runId);
		expect(killed).toBe(true);

		const result = await handle.done;
		expect(result).toMatchObject({
			status: "failed",
			error: "Run killed by user",
		});
		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).resolves.toBeUndefined();
	});

	it("persists stepIndex and sessionId for each step as it completes", async () => {
		const agent = createScriptedAgent(async function* (_opts, callIndex) {
			yield {
				type: "assistant",
				session_id: `sess-${callIndex}`,
				// biome-ignore lint/suspicious/noExplicitAny: shape decoupled from SDK
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000099",
			} as never;
		});

		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: multiStepWorkflow,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({});
		expect(agent.calls).toHaveLength(2);
	});

	it("renders step prompts with template vars and shell expansion", async () => {
		const agent = createScriptedAgent(() => yieldAssistant("sess"));
		await using setup = await createTestRunLifecycle({ agent });

		const workflow: RepoWorkflow = {
			branch: "agent/x",
			base_branch: "main",
			steps: [
				{
					name: "plan",
					prompt: "Plan {{ issue.number }} !`printf one`",
					resume_previous: false,
				},
				{
					name: "implement",
					prompt: "Implement {{ issue.title }} !`printf two`",
					resume_previous: true,
				},
			],
			change_request: baseChangeRequest,
		};

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow,
		});
		await handle.done;

		expect(agent.calls.map((c) => c.prompt)).toEqual([
			"Plan 1 one",
			"Implement Fix login bug two",
		]);
		expect(agent.calls[0]?.resumeSessionId).toBeUndefined();
		expect(agent.calls[1]?.resumeSessionId).toBe("sess");
	});

	it("emits step.started/completed/failed events with the failed step index", async () => {
		let callCount = 0;
		const agent = createScriptedAgent(async function* () {
			callCount++;
			if (callCount === 2) throw new Error("step exploded");
			yield {
				type: "assistant",
				session_id: "sess-plan",
				// biome-ignore lint/suspicious/noExplicitAny: shape decoupled from SDK
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000044",
			} as never;
		});

		await using setup = await createTestRunLifecycle({
			agent,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: multiStepWorkflow,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "failed",
			error: "step exploded",
		});

		const stepEvents = getEvents(setup.db, run?.id ?? "")
			.filter((e) => e.type.startsWith("step."))
			.map((e) => ({ type: e.type, data: e.data }));

		expect(stepEvents).toEqual([
			{
				type: "step.started",
				data: { name: "plan", index: 0, total: 2 },
			},
			{
				type: "step.completed",
				data: { name: "plan", index: 0, durationMs: expect.any(Number) },
			},
			{
				type: "step.started",
				data: { name: "implement", index: 1, total: 2 },
			},
			{
				type: "step.failed",
				data: { name: "implement", index: 1, error: "step exploded" },
			},
		]);
	});

	it("creates the workflow's branch in the cloned workspace before running steps", async () => {
		const branchAtStep = { value: "" };
		const agent = createScriptedAgent(async function* (opts) {
			const { stdout } = await exec(
				"git",
				["rev-parse", "--abbrev-ref", "HEAD"],
				{ cwd: opts.cwd },
			);
			branchAtStep.value = stdout.trim();
			yield {
				type: "assistant",
				session_id: "sess",
				// biome-ignore lint/suspicious/noExplicitAny: shape decoupled from SDK
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000077",
			} as never;
		});

		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		await handle.done;

		expect(branchAtStep.value).toBe("agent/issue-1");
	});

	it("runs .agent/setup.sh from the cloned repo when present", async () => {
		const ranScripts: string[] = [];
		await using setup = await createTestRunLifecycle({
			agent: silentAgent,
			runShell: async (script, cwd) => {
				ranScripts.push(script);
				expect(cwd).toBe(`${setup.workspaceRoot}/test-owner_test-repo_1`);
			},
			beforeFirstStep: async (wsPath) => {
				await writeSetupScript(wsPath, "#!/usr/bin/env bash\necho hi\n");
			},
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		await handle.done;

		expect(ranScripts).toEqual(["bash .agent/setup.sh"]);
	});

	it("skips setup when .agent/setup.sh is absent", async () => {
		const ranScripts: string[] = [];
		await using setup = await createTestRunLifecycle({
			agent: silentAgent,
			runShell: async (script) => {
				ranScripts.push(script);
			},
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		await handle.done;

		expect(ranScripts).toEqual([]);
	});

	it("aborts the run when .agent/setup.sh exits non-zero, no step.started event", async () => {
		await using setup = await createTestRunLifecycle({
			agent: silentAgent,
			runShell: async () => {
				throw new Error("setup.sh exit 1");
			},
			beforeFirstStep: async (wsPath) => {
				await writeSetupScript(wsPath, "#!/usr/bin/env bash\nexit 1\n");
			},
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
		});
		const result = await handle.done;

		expect(result).toMatchObject({
			status: "failed",
			error: "setup.sh exit 1",
		});

		const [run] = setup.db.select().from(runs).all();
		const stepStarted = getEvents(setup.db, run?.id ?? "").filter(
			(e) => e.type === "step.started",
		);
		expect(stepStarted).toEqual([]);
	});

	it("opens the change request with step output substitutions rendered against ctx.outputs", async () => {
		const summarySchema = {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		};
		const agent = createScriptedAgent(async function* () {
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
				structured_output: { title: "Summarised PR title" },
				uuid: "00000000-0000-0000-0000-000000000070",
				session_id: "sess-cr",
			} as never;
		});
		await using setup = await createTestRunLifecycle({ agent });
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: {
				...baseWorkflow,
				steps: [
					{
						name: "summarise",
						prompt: "Summarise",
						resume_previous: false,
						output_schema: summarySchema,
					},
				],
				change_request: {
					title: "{{ steps.summarise.output.title }}",
					body: "Closes {{ issue.key }} ({{ steps.summarise.output.title }})",
				},
			},
		});
		await handle.done;

		expect(setup.codeHost.changeRequests).toEqual([
			{
				repo: TEST_REPO,
				head: "agent/issue-1",
				base: "main",
				title: "Summarised PR title",
				body: `Closes ${issue.key} (Summarised PR title)`,
			},
		]);
	});

	it("opens the change request with values rendered from the workflow's change_request template", async () => {
		await using setup = await createTestRunLifecycle({
			agent: createScriptedAgent(() => yieldAssistant("sess-final")),
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: {
				...baseWorkflow,
				change_request: {
					title: "[{{ issue.key }}] {{ issue.title }}",
					body: "Closes {{ issue.key }}\nBranch: {{ branch }}",
				},
			},
		});
		await handle.done;

		expect(setup.codeHost.changeRequests).toEqual([
			{
				repo: TEST_REPO,
				head: "agent/issue-1",
				base: "main",
				title: `[${issue.key}] ${issue.title}`,
				body: `Closes ${issue.key}\nBranch: agent/issue-1`,
			},
		]);
	});

	it("output step: passes outputFormat to invoker and persists structured_output to run_step_outputs", async () => {
		const summarySchema = {
			type: "object",
			properties: { title: { type: "string" } },
			required: ["title"],
		};
		const structured = { title: "It broke" };
		const agent = createScriptedAgent(async function* () {
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
				uuid: "00000000-0000-0000-0000-000000000050",
				session_id: "sess-out",
			} as never;
		});
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: {
				...baseWorkflow,
				steps: [
					{
						name: "summarise",
						prompt: "Summarise",
						resume_previous: false,
						output_schema: summarySchema,
					},
				],
			},
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(agent.calls[0]?.outputFormat).toEqual({
			type: "json_schema",
			schema: summarySchema,
		});

		const outputRows = setup.db.select().from(runStepOutputs).all();
		expect(outputRows).toEqual([
			{
				runId: handle.runId,
				stepName: "summarise",
				outputJson: structured,
				createdAt: expect.any(String),
			},
		]);
	});

	it("output step: aborts the run when SDK returns error_max_structured_output_retries", async () => {
		const agent = createScriptedAgent(async function* () {
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
				uuid: "00000000-0000-0000-0000-000000000060",
				session_id: "sess-err",
			} as never;
		});
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: {
				...baseWorkflow,
				steps: [
					{
						name: "summarise",
						prompt: "Summarise",
						resume_previous: false,
						output_schema: { type: "object" },
					},
					{ name: "after", prompt: "after", resume_previous: false },
				],
			},
		});
		const result = await handle.done;

		expect(result).toMatchObject({
			status: "failed",
			error: "error_max_structured_output_retries",
		});
		expect(agent.calls).toHaveLength(1);
		expect(setup.db.select().from(runStepOutputs).all()).toEqual([]);
	});

	it("dynamic branch: resolves the branch via the agent, checks it out, and exposes it to step prompts and change_request", async () => {
		const branchSchema = {
			type: "object",
			properties: { name: { type: "string", pattern: "^feat/" } },
			required: ["name"],
		};
		const stepPrompts: string[] = [];
		const branchesAtStep: string[] = [];
		const agent = createScriptedAgent(async function* (opts, callIndex) {
			if (callIndex === 0) {
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
					structured_output: { name: "feat/owner-repo-1-fix-it" },
					uuid: "00000000-0000-0000-0000-000000000080",
					session_id: "sess-branch",
				} as never;
				return;
			}
			stepPrompts.push(opts.prompt);
			const { stdout } = await exec(
				"git",
				["rev-parse", "--abbrev-ref", "HEAD"],
				{ cwd: opts.cwd },
			);
			branchesAtStep.push(stdout.trim());
			yield {
				type: "assistant",
				session_id: "sess",
				// biome-ignore lint/suspicious/noExplicitAny: shape decoupled from SDK
				message: { content: [] } as any,
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000081",
			} as never;
		});

		await using setup = await createTestRunLifecycle({ agent });
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: {
				branch: {
					prompt: "Propose a name for {{ issue.key }}",
					schema: branchSchema,
				},
				base_branch: "main",
				steps: [
					{
						name: "implement",
						prompt: "Working on branch {{ branch }}",
						resume_previous: false,
					},
				],
				change_request: {
					title: "[{{ branch }}] {{ issue.title }}",
					body: "Branch {{ branch }} closes {{ issue.key }}",
				},
			},
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(agent.calls).toHaveLength(2);
		expect(agent.calls[0]).toMatchObject({
			prompt: "Propose a name for owner/repo#1".replace(
				"owner/repo#1",
				issue.key,
			),
			outputFormat: { type: "json_schema", schema: branchSchema },
		});
		expect(stepPrompts).toEqual(["Working on branch feat/owner-repo-1-fix-it"]);
		expect(branchesAtStep).toEqual(["feat/owner-repo-1-fix-it"]);
		expect(setup.codeHost.changeRequests).toEqual([
			{
				repo: TEST_REPO,
				head: "feat/owner-repo-1-fix-it",
				base: "main",
				title: `[feat/owner-repo-1-fix-it] ${issue.title}`,
				body: `Branch feat/owner-repo-1-fix-it closes ${issue.key}`,
			},
		]);
	});

	it("dynamic branch: aborts the run on error_max_structured_output_retries before setup or any step.started", async () => {
		const ranScripts: string[] = [];
		const agent = createScriptedAgent(async function* () {
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
				uuid: "00000000-0000-0000-0000-000000000090",
				session_id: "sess-branch",
			} as never;
		});

		await using setup = await createTestRunLifecycle({
			agent,
			runShell: async (script) => {
				ranScripts.push(script);
			},
			beforeFirstStep: async (wsPath) => {
				await writeSetupScript(wsPath, "#!/usr/bin/env bash\necho hi\n");
			},
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: {
				branch: {
					prompt: "Propose",
					schema: { type: "object" },
				},
				base_branch: "main",
				steps: [
					{ name: "implement", prompt: "Fix it", resume_previous: false },
				],
				change_request: baseChangeRequest,
			},
		});
		const result = await handle.done;

		expect(result).toMatchObject({
			status: "failed",
			error: "error_max_structured_output_retries",
		});
		expect(ranScripts).toEqual([]);
		expect(agent.calls).toHaveLength(1);

		const [run] = setup.db.select().from(runs).all();
		const stepStarted = getEvents(setup.db, run?.id ?? "").filter(
			(e) => e.type === "step.started",
		);
		expect(stepStarted).toEqual([]);
	});
});
