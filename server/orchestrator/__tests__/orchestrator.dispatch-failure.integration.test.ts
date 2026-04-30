import { access } from "node:fs/promises";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	failingAgent,
	GITHUB_API,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator dispatch failure and polling", () => {
	it("preserves workspace on agent failure when retries remain", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 3 },
			runAgent: failingAgent,
		});
		const { orchestrator, db, runner, workspace } = ctx;
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-1",
				status: "failed",
				error: "agent exploded",
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);

		// Workspace should still exist (not cleaned up)
		await expect(access(wsDir)).resolves.toBeUndefined();
	});

	it("cleans up workspace on agent failure when retries exhausted", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 0 },
			runAgent: failingAgent,
		});
		const { orchestrator, runner, workspace } = ctx;
		const wsDir = await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		// Workspace should be cleaned up
		await expect(access(wsDir)).rejects.toThrow();
	});

	it("swaps label back to pending when retries exhausted", async () => {
		// Strict one-shot handlers in dispatch order:
		// 1. DELETE labels/agent       (initial swap pending → running)
		// 2. POST labels [agent:running]
		// 3. DELETE labels/agent:running (rollback running → pending)
		// 4. POST labels [agent]         (rollback)
		// Each handler validates the exact expected shape and is consumed by its
		// turn in the sequence. We assert via MSW's `isUsed` rather than
		// capturing request data outside the handler.
		const initialDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const initialPost = http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				if (body.labels[0] !== "agent:running") {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			},
			{ once: true },
		);
		const rollbackDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent:running`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const rollbackPost = http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				if (body.labels[0] !== "agent") {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			},
			{ once: true },
		);

		server.use(
			initialDelete,
			initialPost,
			rollbackDelete,
			rollbackPost,
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 0 },
			runAgent: failingAgent,
		});
		const { orchestrator, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(rollbackDelete.isUsed).toBe(true);
		expect(rollbackPost.isUsed).toBe(true);
	});

	it("does not crash when label rollback fails after retries exhausted", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// First delete (dispatch: remove "agent") succeeds, second (rollback: remove "agent:running") fails
		server.use(
			http.delete(
				`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
				function* () {
					yield new HttpResponse(null, { status: 204 });
					return new HttpResponse(null, { status: 500 });
				},
			),
		);

		await using ctx = await createTestOrchestrator({
			configOverrides: { max_retries: 0 },
			runAgent: failingAgent,
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
				status: "failed",
				error: "agent exploded",
				issueKey: `${REPO}#1`,
				issueTitle: "Issue 1",
				startedAt: expect.any(String),
				completedAt: expect.any(String),
				durationMs: expect.any(Number),
				sessionId: null,
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);
	});

	it("continues processing when dispatch rollback label swap fails", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);
		// Override: label delete succeeds for "agent" (initial swap) but fails
		// for "agent:running" (the rollback after dispatch failure)
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

		// Don't pre-create workspace so git clone fails → dispatch fails → rollback fires
		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			codeHost: (defaults) => ({
				...defaults,
				cloneUrl: () => "/nonexistent/repo.git",
			}),
		});
		const { orchestrator, db } = ctx;

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(0);
	});
});
