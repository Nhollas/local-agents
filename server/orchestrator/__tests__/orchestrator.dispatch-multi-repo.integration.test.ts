import { describe, expect, it } from "vitest";
import { runs } from "../../db/schema.ts";
import {
	createScopedJiraIssue,
	hangingAgent,
	jiraIssueKey,
	REPO,
	STATUSES,
} from "../../testing/support/fixtures.ts";
import {
	gitlabHandlers,
	jiraHandlers,
	server,
} from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";
import { repoSlug } from "../../types/brands.ts";

describe("Orchestrator multi-repo scheduling", () => {
	it("ticking guard prevents concurrent ticks", async () => {
		let pendingFetchCount = 0;

		server.use(
			...jiraHandlers({
				resolveIssues: (status) => {
					if (status === "pending") {
						pendingFetchCount++;
						return [createScopedJiraIssue(1)];
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
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await Promise.all([orchestrator.tick(), orchestrator.tick()]);

		// Only one tick should have fetched issues — the second bailed at the guard.
		expect(pendingFetchCount).toBe(1);
	});

	it("dispatches issues across multiple repos in oldest-first order", async () => {
		const REPO2 = repoSlug("other-group/second-repo");

		server.use(
			...jiraHandlers({
				issues: [
					createScopedJiraIssue(
						1,
						STATUSES.pending,
						"2025-01-01T00:00:00.000+0000",
						REPO,
					),
					createScopedJiraIssue(
						2,
						STATUSES.pending,
						"2025-01-02T00:00:00.000+0000",
						REPO2,
					),
				],
			}),
			...gitlabHandlers(),
		);

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
			trackerScopes: [REPO, REPO2],
		});
		const { orchestrator, db, runner, workspace } = ctx;
		await workspace.preCreateWorkspace(jiraIssueKey(1));
		await workspace.preCreateWorkspace(jiraIssueKey(2));

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(2);
		expect(new Set(allRuns.map((r) => r.issueKey))).toEqual(
			new Set([jiraIssueKey(1), jiraIssueKey(2)]),
		);
	});
});
