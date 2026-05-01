import { access } from "node:fs/promises";
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

const baseWorkflow: RepoWorkflow = {
	branch: "agent/issue-{{ issue.number }}",
	base_branch: "main",
	phases: [
		{
			name: "implement",
			prompt: "Fix issue {{ issue.number }}: {{ issue.title }}",
			resume_previous: false,
		},
	],
};

const phasedWorkflow: RepoWorkflow = {
	branch: "agent/issue-{{ issue.number }}",
	base_branch: "main",
	phases: [
		{ name: "plan", prompt: "Plan {{ issue.number }}", resume_previous: false },
		{
			name: "implement",
			prompt: "Implement {{ issue.title }}",
			resume_previous: true,
		},
	],
};

describe("RunLifecycle.dispatch", () => {
	it("happy path: clones, runs hooks and phases, opens PR, transitions, cleans up", async () => {
		const hookOrder: string[] = [];
		await using setup = await createTestRunLifecycle({
			agent: createScriptedAgent(() => yieldAssistant("sess-final")),
			runShell: async (script, _cwd) => {
				hookOrder.push(script);
			},
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: {
				...baseWorkflow,
				hooks: {
					after_create: "echo after_create",
					before_run: "echo before_run",
					after_run: "echo after_run",
				},
			},
			attempt: 1,
		});

		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(hookOrder).toEqual([
			"echo after_create",
			"echo before_run",
			"echo after_run",
		]);
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
			phaseIndex: 0,
		});

		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).rejects.toThrow();
	});

	it("phase failure with retries remaining: workspace kept, no tracker rollback", async () => {
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("phase exploded");
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

		expect(result).toMatchObject({ status: "failed", error: "phase exploded" });
		expect(setup.tracker.transitions).toEqual([]);
		await expect(
			access(`${setup.workspaceRoot}/test-owner_test-repo_1`),
		).resolves.toBeUndefined();
	});

	it("phase failure on terminal attempt: workspace removed, tracker rolls back to pending", async () => {
		// biome-ignore lint/correctness/useYield: throws before yielding
		const explodingAgent = createScriptedAgent(async function* () {
			throw new Error("phase exploded");
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

	it("retry resume: skips earlier phases and feeds sessionId to the failed phase", async () => {
		const agent = createScriptedAgent((_opts) => yieldAssistant("sess-new"));
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: phasedWorkflow,
			attempt: 2,
			resume: {
				parentRunId: "parent-run" as never,
				startPhaseIndex: 1,
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

	it("retry without sessionId: failed phase runs fresh", async () => {
		const agent = createScriptedAgent(() => yieldAssistant("sess-new"));
		await using setup = await createTestRunLifecycle({ agent });

		const handle = await setup.lifecycle.dispatch({
			issue: createTestIssue(),
			repo: TEST_REPO,
			workflow: phasedWorkflow,
			attempt: 2,
			resume: {
				parentRunId: "parent-run" as never,
				startPhaseIndex: 1,
			},
		});
		await handle.done;

		expect(agent.calls).toHaveLength(1);
		expect(agent.calls[0]?.resumeSessionId).toBeUndefined();
	});

	it("after_run hook failure does not fail the run", async () => {
		await using setup = await createTestRunLifecycle({
			agent: silentAgent,
			runShell: async (script) => {
				if (script.includes("after_run")) throw new Error("after_run failed");
			},
		});
		const issue = createTestIssue();

		const handle = await setup.lifecycle.dispatch({
			issue,
			repo: TEST_REPO,
			workflow: { ...baseWorkflow, hooks: { after_run: "exit-after_run" } },
			attempt: 1,
		});
		const result = await handle.done;

		expect(result).toMatchObject({ status: "completed" });
		expect(setup.tracker.transitions).toEqual([
			{
				repo: TEST_REPO,
				number: issue.number,
				from: "running",
				to: "awaiting_review",
			},
		]);
	});

	it("PR creation failure: tracker transition still attempted, run still completes", async () => {
		const tracker = createInMemoryTracker(createTestIssue());
		const codeHost = createInMemoryCodeHost("file:///dummy");
		codeHost.failChangeRequest();

		await using setup = await createTestRunLifecycle({ tracker, codeHost });
		// Re-point cloneUrl to the bare repo since failChangeRequest does not interact with cloneUrl
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

	it("abort mid-phase: result is failed with abort error, workspace kept", async () => {
		let releaseAbortable: () => void = () => {};
		const abortableAgent = createScriptedAgent(async function* (opts) {
			yield* (async function* (): AsyncGenerator<never> {
				await new Promise<void>((resolve) => {
					releaseAbortable = resolve;
					opts.signal.addEventListener("abort", () => resolve());
				});
				if (opts.signal.aborted) throw new Error("phase saw abort");
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

		// Wait until the agent is mid-flight, then kill.
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

	it("persists phaseIndex and sessionId for each phase as it completes", async () => {
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
			workflow: phasedWorkflow,
			attempt: 1,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			phaseIndex: 1,
			sessionId: "sess-1",
		});
		expect(agent.calls).toHaveLength(2);
	});

	it("before_run hook failure throws from dispatch (no run is enqueued)", async () => {
		await using setup = await createTestRunLifecycle({
			runShell: async (script) => {
				if (script.includes("before_run")) throw new Error("before_run failed");
			},
		});

		await expect(
			setup.lifecycle.dispatch({
				issue: createTestIssue(),
				repo: TEST_REPO,
				workflow: { ...baseWorkflow, hooks: { before_run: "exit-before_run" } },
				attempt: 1,
			}),
		).rejects.toThrow(/before_run failed/);

		expect(setup.db.select().from(runs).all()).toEqual([]);
	});

	it("renders phase prompts with template vars and shell expansion", async () => {
		const agent = createScriptedAgent(() => yieldAssistant("sess"));
		await using setup = await createTestRunLifecycle({ agent });

		const workflow: RepoWorkflow = {
			branch: "agent/x",
			base_branch: "main",
			phases: [
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

	it("emits phase.started/completed/failed events with the failed phase index", async () => {
		let callCount = 0;
		const agent = createScriptedAgent(async function* () {
			callCount++;
			if (callCount === 2) throw new Error("phase exploded");
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
			workflow: phasedWorkflow,
			attempt: 1,
		});
		await handle.done;

		const [run] = setup.db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "failed",
			error: "phase exploded",
			sessionId: "sess-plan",
			phaseIndex: 1,
		});

		const phaseEvents = getEvents(setup.db, run?.id ?? "")
			.filter((e) => e.type.startsWith("phase."))
			.map((e) => ({ type: e.type, data: e.data }));

		expect(phaseEvents).toEqual([
			{
				type: "phase.started",
				data: { name: "plan", index: 0, total: 2 },
			},
			{
				type: "phase.completed",
				data: { name: "plan", index: 0, durationMs: expect.any(Number) },
			},
			{
				type: "phase.started",
				data: { name: "implement", index: 1, total: 2 },
			},
			{
				type: "phase.failed",
				data: { name: "implement", index: 1, error: "phase exploded" },
			},
		]);
	});
});
