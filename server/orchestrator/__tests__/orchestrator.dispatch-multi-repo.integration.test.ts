import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	createSessionAgent,
	createTestWorkflow,
	GITHUB_API,
	hangingAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

describe("Orchestrator dispatch multi-repo", () => {
	it("ticking guard prevents concurrent ticks", async () => {
		let issuesFetchCount = 0;

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent") {
						issuesFetchCount++;
						return [createGitHubIssue(1, ["agent"])];
					}
					return [];
				},
			}),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			runAgent: hangingAgent,
		});
		const { orchestrator, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);

		await Promise.all([orchestrator.tick(), orchestrator.tick()]);

		// Only one tick should have fetched issues — the second bailed at the guard
		expect(issuesFetchCount).toBe(1);
	});

	it("fetch failure for one repo does not block other repos", async () => {
		const REPO2 = "test-owner/second-repo";

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			// First repo: issues endpoint returns 500
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, () => {
				return new HttpResponse(null, { status: 500 });
			}),
			// Second repo: returns a valid issue
			http.get(`${GITHUB_API}/repos/${REPO2}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([createGitHubIssue(10, ["agent"])]);
				}
				return HttpResponse.json([]);
			}),
			http.delete(
				`${GITHUB_API}/repos/${REPO2}/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/${REPO2}/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITHUB_API}/repos/${REPO2}/pulls`, () =>
				HttpResponse.json({
					number: 1,
					html_url: `https://github.com/${REPO2}/pull/1`,
				}),
			),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			workflows: new Map<string, RepoWorkflow>([
				[REPO, createTestWorkflow()],
				[REPO2, createTestWorkflow()],
			]),
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO2}#10`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual([
			{
				id: expect.any(String),
				agentName: "issue-10",
				status: "completed",
				error: null,
				issueKey: `${REPO2}#10`,
				issueTitle: "Issue 10",
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

	it("dispatches issues across multiple repos", async () => {
		const REPO2 = "test-owner/second-repo";

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([
						createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z"),
					]);
				}
				return HttpResponse.json([]);
			}),
			http.get(`${GITHUB_API}/repos/${REPO2}/issues`, ({ request }) => {
				const url = new URL(request.url);
				const label = url.searchParams.get("labels");
				if (label === "agent") {
					return HttpResponse.json([
						createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z"),
					]);
				}
				return HttpResponse.json([]);
			}),
			http.delete(
				`${GITHUB_API}/repos/:owner/:repo/issues/:number/labels/:label`,
				() => new HttpResponse(null, { status: 204 }),
			),
			http.post(`${GITHUB_API}/repos/:owner/:repo/issues/:number/labels`, () =>
				HttpResponse.json([]),
			),
			http.post(`${GITHUB_API}/repos/:owner/:repo/pulls`, () =>
				HttpResponse.json({
					number: 1,
					html_url: "https://github.com/test/pull/1",
				}),
			),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			workflows: new Map<string, RepoWorkflow>([
				[REPO, createTestWorkflow()],
				[REPO2, createTestWorkflow()],
			]),
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		await workspace.preCreateWorkspace(`${REPO2}#2`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toEqual(
			expect.arrayContaining([
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
					phaseIndex: 0,
				},
				{
					id: expect.any(String),
					agentName: "issue-2",
					status: "completed",
					error: null,
					issueKey: `${REPO2}#2`,
					issueTitle: "Issue 2",
					startedAt: expect.any(String),
					completedAt: expect.any(String),
					durationMs: expect.any(Number),
					sessionId: null,
					attempt: 1,
					parentRunId: null,
					phaseIndex: 0,
				},
			]),
		);
		expect(allRuns).toHaveLength(2);
	});

	it("stores sessionId when agent emits assistant messages", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		await using ctx = await createTestOrchestrator({
			runAgent: createSessionAgent("test-sess-abc", [
				{ type: "text", text: "Working on it" },
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
				sessionId: "test-sess-abc",
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);
	});

	it("completes run when agent emits non-assistant messages", async () => {
		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
			}),
		);

		// biome-ignore lint/suspicious/noExplicitAny: decouple test fixture from SDK's message shape
		async function* mixedMessageAgent(): AsyncGenerator<any> {
			yield { type: "system" };
			yield {
				type: "assistant",
				session_id: "sess-mixed",
				message: { content: [] },
				parent_tool_use_id: null,
				uuid: "00000000-0000-0000-0000-000000000099",
			};
		}

		await using ctx = await createTestOrchestrator({
			runAgent: mixedMessageAgent,
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
				sessionId: "sess-mixed",
				attempt: 1,
				parentRunId: null,
				phaseIndex: 0,
			},
		]);
	});
});
