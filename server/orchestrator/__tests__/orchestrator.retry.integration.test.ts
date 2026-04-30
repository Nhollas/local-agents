import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	createPromptSpyAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

const failedRunDefaults = {
	agentName: "issue-1",
	status: "failed" as const,
	issueKey: `${REPO}#1`,
	issueTitle: "Test issue",
	completedAt: new Date().toISOString(),
	error: "agent exploded",
	sessionId: "sess-abc",
	attempt: 1,
};

describe("Orchestrator retryRun", () => {
	it("retries a failed run and creates a new run record", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, { ...failedRunDefaults, id: "failed-1" });

		const result = await orchestrator.retryRun("failed-1");
		expect(result).toEqual({ runId: expect.any(String) });

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		const retryRun = allRuns.find((r) => r.id !== "failed-1");
		expect(retryRun).toEqual({
			id: expect.any(String),
			agentName: "issue-1",
			status: "completed",
			error: null,
			issueKey: `${REPO}#1`,
			issueTitle: "Issue 1",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: "sess-abc",
			attempt: 2,
			parentRunId: "failed-1",
			phaseIndex: 0,
		});
	});

	it("passes resume option to runAgent with the previous sessionId", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, {
			...failedRunDefaults,
			id: "failed-2",
			sessionId: "sess-resume-me",
		});

		await orchestrator.retryRun("failed-2");
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(getCaptured().options).toEqual({
			cwd: expect.stringContaining("test-owner_test-repo_1"),
			model: "claude-sonnet-4-6",
			allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
			permissionMode: "dontAsk",
			resume: "sess-resume-me",
		});
	});

	it("rejects retry when run does not exist", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator();
		const { orchestrator } = ctx;

		const result = await orchestrator.retryRun("nonexistent-id");
		expect(result).toEqual({ error: "Run not found" });
	});

	it("uses fetched issue title even when failed run has no stored issueTitle", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, {
			...failedRunDefaults,
			id: "no-title",
			issueTitle: null,
		});

		const result = await orchestrator.retryRun("no-title");
		expect(result).toEqual({ runId: expect.any(String) });

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		const retryRun = allRuns.find((r) => r.id !== "no-title");
		expect(retryRun).toEqual({
			id: expect.any(String),
			agentName: "issue-1",
			status: "completed",
			error: null,
			issueKey: `${REPO}#1`,
			issueTitle: "Issue 1",
			startedAt: expect.any(String),
			completedAt: expect.any(String),
			durationMs: expect.any(Number),
			sessionId: "sess-abc",
			attempt: 2,
			parentRunId: "no-title",
			phaseIndex: 0,
		});
	});

	it("rejects retry when run is not failed", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db } = ctx;
		seedRun(db, {
			...failedRunDefaults,
			id: "completed-1",
			status: "completed",
			error: undefined,
		});

		const result = await orchestrator.retryRun("completed-1");
		expect(result).toEqual({ error: "Run is not failed" });
	});

	it("retries fresh when run has no sessionId", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent:running"])],
			}),
		);

		const { spyAgent, getCaptured } = createPromptSpyAgent();

		await using ctx = await createTestOrchestrator({
			runAgent: spyAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		seedRun(db, { ...failedRunDefaults, id: "no-sess", sessionId: null });

		const result = await orchestrator.retryRun("no-sess");
		expect(result).toEqual({ runId: expect.any(String) });

		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(getCaptured().options).not.toHaveProperty("resume");
	});

	it("rejects retry when max retries exceeded", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 3 },
		});
		const { orchestrator, db } = ctx;
		seedRun(db, { ...failedRunDefaults, id: "maxed-out", attempt: 4 });

		const result = await orchestrator.retryRun("maxed-out");
		expect(result).toEqual({ error: "Max retries exceeded" });
	});

	it("rejects retry when run has no issue key", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db } = ctx;
		seedRun(db, { ...failedRunDefaults, id: "no-issue", issueKey: null });

		const result = await orchestrator.retryRun("no-issue");
		expect(result).toEqual({ error: "No issue key" });
	});

	it("rejects retry when no workflow exists for the repo", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator({
			// Empty workflows map — no workflow for the repo
			workflows: new Map<string, RepoWorkflow>(),
		});
		const { orchestrator, db } = ctx;
		seedRun(db, { ...failedRunDefaults, id: "no-workflow" });

		const result = await orchestrator.retryRun("no-workflow");
		expect(result).toEqual({ error: "No workflow for repo" });
	});

	it("rejects retry when issue already has a running agent", async () => {
		server.use(...githubHandlers());

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db } = ctx;
		seedRun(db, { ...failedRunDefaults, id: "failed-dup" });
		seedRun(db, {
			id: "running-1",
			agentName: "issue-1",
			status: "running",
			issueKey: `${REPO}#1`,
		});

		const result = await orchestrator.retryRun("failed-dup");
		expect(result).toEqual({ error: "Issue already has a running agent" });
	});
});
