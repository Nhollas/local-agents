import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { getEvents, seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { runId as rid } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

const failedRunDefaults = {
	agentName: "issue-1",
	status: "failed" as const,
	issueKey: `${REPO}#1`,
	issueTitle: "Fix the login bug",
	completedAt: new Date().toISOString(),
	error: "agent exploded",
	attempt: 1,
};

function phasedWorkflow(overrides: Partial<RepoWorkflow> = {}): RepoWorkflow {
	return {
		branch: "agent/issue-{{ issue.number }}",
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
		...overrides,
	};
}

describe("Orchestrator multi-phase workflows", () => {
	it("runs phases sequentially with freshly rendered and shell-expanded prompts", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		const { spyAgent, getCapturedCalls } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, phasedWorkflow()]]),
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const calls = getCapturedCalls();
		expect(calls.map((call) => call.prompt)).toEqual([
			"Plan 1 one",
			"Implement Issue 1 two",
		]);
		expect(calls[0]?.options).not.toHaveProperty("resume");
		expect(calls[1]?.options).toMatchObject({ resume: "spy-session" });

		const [run] = db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "completed",
			sessionId: "spy-session",
			phaseIndex: 1,
		});

		const events = getEvents(db, run?.id ?? "");
		expect(
			events
				.filter((event) => event.type.startsWith("phase."))
				.map((event) => event.type),
		).toEqual([
			"phase.started",
			"phase.completed",
			"phase.started",
			"phase.completed",
		]);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "phase.started",
				data: { name: "plan", index: 0, total: 2 },
			}),
		);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "phase.started",
				data: { name: "implement", index: 1, total: 2 },
			}),
		);
	});

	it("runs hooks once around the whole dispatch", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		const sentinel = join(tmpdir(), `phase-hooks-${Date.now()}`);

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[
					REPO,
					phasedWorkflow({
						hooks: {
							before_run: `printf before >> ${sentinel}`,
							after_run: `printf after >> ${sentinel}`,
						},
					}),
				],
			]),
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		await expect(readFile(sentinel, "utf8")).resolves.toBe("beforeafter");
		await rm(sentinel, { force: true });
	});

	it("records the failed phase index and emits a phase failure marker", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		let calls = 0;

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, phasedWorkflow()]]),
			runAgent: async function* failSecondPhaseAgent() {
				calls++;
				if (calls === 2) throw new Error("phase exploded");
				yield {
					type: "assistant" as const,
					session_id: "sess-plan",
					// biome-ignore lint/suspicious/noExplicitAny: decouple test fixture from SDK's BetaMessage shape
					message: { content: [] } as any,
					parent_tool_use_id: null,
					uuid: "00000000-0000-0000-0000-000000000004" as const,
				};
			},
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const [run] = db.select().from(runs).all();
		expect(run).toMatchObject({
			status: "failed",
			error: "phase exploded",
			sessionId: "sess-plan",
			phaseIndex: 1,
		});
		expect(getEvents(db, run?.id ?? "")).toContainEqual(
			expect.objectContaining({
				type: "phase.failed",
				data: { name: "implement", index: 1, error: "phase exploded" },
			}),
		);
	});

	it("retries from the failed phase and resumes its stored session", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCapturedCalls } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, phasedWorkflow()]]),
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, {
			...failedRunDefaults,
			id: "failed-phase",
			sessionId: "sess-failed-phase",
			phaseIndex: 1,
		});

		await expect(orchestrator.retryRun(rid("failed-phase"))).resolves.toEqual({
			runId: expect.any(String),
		});
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const calls = getCapturedCalls();
		expect(calls.map((call) => call.prompt)).toEqual(["Implement Issue 1 two"]);
		expect(calls[0]?.options).toMatchObject({ resume: "sess-failed-phase" });

		const retryRun = db
			.select()
			.from(runs)
			.all()
			.find((run) => run.id !== "failed-phase");
		expect(retryRun).toMatchObject({
			status: "completed",
			attempt: 2,
			parentRunId: "failed-phase",
			phaseIndex: 1,
		});
	});

	it("retries the failed phase fresh when it has no stored session", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCapturedCalls } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			workflows: new Map([[REPO, phasedWorkflow()]]),
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, {
			...failedRunDefaults,
			id: "failed-no-session",
			sessionId: null,
			phaseIndex: 1,
		});

		await expect(
			orchestrator.retryRun(rid("failed-no-session")),
		).resolves.toEqual({
			runId: expect.any(String),
		});
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const calls = getCapturedCalls();
		expect(calls.map((call) => call.prompt)).toEqual(["Implement Issue 1 two"]);
		expect(calls[0]?.options).not.toHaveProperty("resume");
	});
});
