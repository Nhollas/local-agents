import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	createTestWorkflow,
	GITHUB_API,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator dispatch hooks and completion", () => {
	it("before_run hook executes before agent starts", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		// Custom agent that checks marker file exists during execution
		let markerExistedDuringRun = false;

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[REPO, createTestWorkflow({ hooks: { before_run: "touch marker" } })],
			]),
			// biome-ignore lint/correctness/useYield: agent only needs side effects, no messages to yield
			runAgent: async function* checkMarkerAgent() {
				const wsDir = join(ctx.workspace.root, "test-owner_test-repo_1");
				try {
					await access(join(wsDir, "marker"));
					markerExistedDuringRun = true;
				} catch {
					markerExistedDuringRun = false;
				}
			},
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(markerExistedDuringRun).toBe(true);
	});

	it("after_run hook executes after agent handler completes", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		// The after_run hook writes a marker file outside the workspace root
		// so it survives workspace cleanup by onFinally
		const sentinelPath = join(tmpdir(), `after_marker_sentinel-${Date.now()}`);

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[
					REPO,
					createTestWorkflow({
						hooks: { after_run: `touch ${sentinelPath}` },
					}),
				],
			]),
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		await expect(access(sentinelPath)).resolves.toBeUndefined();
		await rm(sentinelPath, { force: true });
	});

	it("before_run failure prevents dispatch", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[REPO, createTestWorkflow({ hooks: { before_run: "exit 1" } })],
			]),
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);
	});

	it("transitions label to awaiting-review even when PR creation fails", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);
		// PR 500 handler registered AFTER githubHandlers so MSW checks it FIRST (LIFO)
		server.use(
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "completed",
				error: null,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);

		// PR creation failed, but label should still transition to awaiting-review
		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("after_run hook failure does not prevent completion", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		await using ctx = await createTestOrchestrator({
			workflows: new Map([
				[REPO, createTestWorkflow({ hooks: { after_run: "exit 1" } })],
			]),
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "completed",
				error: null,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);

		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("does not crash when both PR creation and label recovery fail", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// PR creation fails
		server.use(
			http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
		);
		// Label delete succeeds for "agent" (dispatch) but fails for "agent:running" (recovery)
		server.use(
			http.delete<{ label: string }>(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				({ params }) => {
					const label = decodeURIComponent(params.label);
					if (label === "agent:running") {
						return new HttpResponse(null, { status: 500 });
					}
					return new HttpResponse(null, { status: 204 });
				},
			),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "completed",
				error: null,
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
			},
		]);
	});

	it("onFinally triggers workspace cleanup", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator();
		const { orchestrator, runner, workspace } = ctx;
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// Workspace should have been cleaned up by onFinally → removeWorkspace
		await expect(access(wsDir)).rejects.toThrow();
	});
});
