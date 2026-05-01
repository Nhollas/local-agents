import { execFile } from "node:child_process";
import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
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
			attempt: 1,
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
			sessionId: "sess-final",
			stepIndex: 0,
		});

		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).rejects.toThrow();
	});

	it("step failure with retries remaining: workspace kept, no tracker rollback", async () => {
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("step exploded");
		});
		await using setup = await createTestRunLifecycle({
			agent: explodingAgent,
			maxRetries: 3,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
			attempt: 1,
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "failed", error: "step exploded" });
		expect(setup.tracker.transitions).toEqual([]);
		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).resolves.toBeUndefined();
	});

	it("step failure on terminal attempt: workspace removed, tracker rolls back to pending", async () => {
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("step exploded");
		});
		await using setup = await createTestRunLifecycle({
			agent: explodingAgent,
			maxRetries: 0,
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: baseWorkflow,
			attempt: 1,
		});
		await handle.done;

		expect(setup.tracker.transitions).toEqual([
			{
				repo: TEST_REPO,
				number: issue.number,
				from: "running",
				to: "pending",
			},
		]);
		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).rejects.toThrow();
	});

	it("retry resume: skips earlier steps and feeds sessionId to the failed step", async () => {
		const agent = createScriptedAgent((_opts) => yieldAssistant("sess-new"));
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: multiStepWorkflow,
			attempt: 2,
			resume: {
				parentRunId: "parent-run" as never,
				startStepIndex: 1,
				sessionId: "sess-failed",
			},
		});
		await handle.done;

		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]).toMatchObject({
			prompt: "Implement Fix login bug",
			resumeSessionId: "sess-failed",
		});
	});

	it("retry without sessionId: failed step runs fresh", async () => {
		const agent = createScriptedAgent(() => yieldAssistant("sess-new"));
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: multiStepWorkflow,
			attempt: 2,
			resume: {
				parentRunId: "parent-run" as never,
				startStepIndex: 1,
			},
		});
		await handle.done;

		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]?.resumeSessionId).toBeUndefined();
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
			attempt: 1,
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
			maxRetries: 3,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: baseWorkflow,
			attempt: 1,
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
			attempt: 1,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			stepIndex: 1,
			sessionId: "sess-1",
		});
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
		};

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow,
			attempt: 1,
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
			maxRetries: 3,
		});

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: multiStepWorkflow,
			attempt: 1,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "failed",
			error: "step exploded",
			sessionId: "sess-plan",
			stepIndex: 1,
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
			attempt: 1,
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
			attempt: 1,
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
			attempt: 1,
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
			attempt: 1,
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
});
