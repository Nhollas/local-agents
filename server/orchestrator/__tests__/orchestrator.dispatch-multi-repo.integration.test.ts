import { describe, expect, it } from "vitest";
import {
	hangingAgent,
	jiraIssueKey,
	REPO,
} from "../../__test-support__/support/fixtures.ts";
import { createTestOrchestrator } from "../../__test-support__/support/test-orchestrator.ts";
import { runs } from "../../db/schema.ts";
import { repoSlug } from "../../types/brands.ts";

describe("Orchestrator multi-repo scheduling", () => {
	it("ticking guard prevents concurrent ticks", async () => {
		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			runAgent: hangingAgent,
		});
		const { orchestrator, workspace, tracker } = ctx;
		tracker.addIssue("pending", { number: 1, repo: REPO });
		await workspace.preCreateWorkspace(jiraIssueKey(1));

		await Promise.all([orchestrator.tick(), orchestrator.tick()]);

		// Only one tick should have fetched issues — the second bailed at the guard.
		expect(tracker.fetchCalls.filter((s) => s === "pending")).toHaveLength(1);
	});

	it("dispatches issues across multiple repos in oldest-first order", async () => {
		const REPO2 = repoSlug("other-group/second-repo");

		await using ctx = await createTestOrchestrator({
			maxConcurrency: 5,
			configOverrides: { max_concurrent: 5 },
		});
		const { orchestrator, db, runner, workspace, tracker } = ctx;
		tracker.addIssue("pending", {
			number: 1,
			repo: REPO,
			createdAt: "2025-01-01T00:00:00.000+0000",
		});
		tracker.addIssue("pending", {
			number: 2,
			repo: REPO2,
			createdAt: "2025-01-02T00:00:00.000+0000",
		});
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
