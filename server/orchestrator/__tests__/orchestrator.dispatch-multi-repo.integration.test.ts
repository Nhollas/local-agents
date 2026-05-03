import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createGitHubIssue,
	GITHUB_API,
	hangingAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { repoSlug } from "../../types/brands.ts";

describe("Orchestrator multi-repo scheduling", () => {
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

		// Only one tick should have fetched issues — the second bailed at the guard.
		expect(issuesFetchCount).toBe(1);
	});

	it("fetch failure for one org does not block other orgs", async () => {
		const REPO2 = repoSlug("other-org/second-repo");

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
				const q = new URL(request.url).searchParams.get("q") ?? "";
				if (q.startsWith(`org:test-owner `)) {
					return new HttpResponse(null, { status: 500 });
				}
				if (q.startsWith(`org:other-org `)) {
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(10, ["agent"], undefined, REPO2)],
					});
				}
				return HttpResponse.json({ total_count: 0, items: [] });
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
			trackerScopes: [REPO, REPO2],
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO2}#10`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0]).toMatchObject({
			issueKey: `${REPO2}#10`,
			status: "completed",
		});
	});

	it("dispatches issues across multiple repos in oldest-first order", async () => {
		const REPO2 = repoSlug("other-org/second-repo");

		server.use(
			http.get(`${GITHUB_API}/user`, () =>
				HttpResponse.json({ login: "test-user" }),
			),
			http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
				const q = new URL(request.url).searchParams.get("q") ?? "";
				if (q.startsWith(`org:test-owner `)) {
					return HttpResponse.json({
						total_count: 1,
						items: [createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z")],
					});
				}
				if (q.startsWith(`org:other-org `)) {
					return HttpResponse.json({
						total_count: 1,
						items: [
							createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z", REPO2),
						],
					});
				}
				return HttpResponse.json({ total_count: 0, items: [] });
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
			trackerScopes: [REPO, REPO2],
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(`${REPO}#1`);
		await workspace.preCreateWorkspace(`${REPO2}#2`);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(2);
		expect(new Set(allRuns.map((r) => r.issueKey))).toEqual(
			new Set([`${REPO}#1`, `${REPO2}#2`]),
		);
	});
});
