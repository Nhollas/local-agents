import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
	createGitHubIssue,
	GITHUB_API,
	noopAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator post-run recovery", () => {
	it("reconciles issue labeled agent:running in GitHub when DB run is already completed", async () => {
		// Strict one-shot handlers for the recovery swap (running → pending):
		// DELETE labels/agent:running, then POST labels [agent]. We assert via
		// `isUsed` rather than capturing request data.
		const recoveryDelete = http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/agent:running`,
			() => new HttpResponse(null, { status: 204 }),
			{ once: true },
		);
		const recoveryPost = http.post(
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
			recoveryDelete,
			recoveryPost,
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent:running")
						return [createGitHubIssue(1, ["agent:running"])];
					return [];
				},
			}),
		);

		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const { orchestrator, db, runner } = ctx;

		seedRun(db, {
			id: "completed-orphan",
			agentName: "issue-1",
			status: "completed",
			issueKey: `${REPO}#1`,
			issueTitle: "Issue 1",
			completedAt: new Date().toISOString(),
			durationMs: 1000,
			attempt: 1,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(recoveryDelete.isUsed).toBe(true);
		expect(recoveryPost.isUsed).toBe(true);
	});
});
