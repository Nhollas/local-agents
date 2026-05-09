import { describe, expect, it } from "vitest";
import { jiraIssueKey, REPO } from "../../__test-support__/support/fixtures.ts";
import { seedRun } from "../../__test-support__/support/test-db.ts";
import { createTestOrchestrator } from "../../__test-support__/support/test-orchestrator.ts";
import type { Db } from "../../db/db.ts";
import { runs } from "../../db/schema.ts";

function seedStaleRun(db: Db) {
	seedRun(db, {
		id: "stale-run",
		agentName: "issue-5",
		status: "running",
		issueKey: jiraIssueKey(5),
		issueTitle: "Stale issue",
		startedAt: "2025-01-01T00:00:00Z",
	});
}

describe("Orchestrator startup recovery", () => {
	it("fails DB runs left in 'running' from a previous process", async () => {
		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, db } = ctx;

		seedStaleRun(db);

		await orchestrator.recover();

		expect(db.select().from(runs).all()).toEqual([
			{
				id: "stale-run",
				agentName: "issue-5",
				status: "failed",
				error: "Stale run from previous session",
				repo: REPO,
				issueKey: jiraIssueKey(5),
				issueTitle: "Stale issue",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: null,
			},
		]);
	});

	it("transitions tracker issues stuck in 'running' back to 'pending'", async () => {
		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, tracker } = ctx;
		tracker.addIssue("running", { number: 7, repo: REPO });

		await orchestrator.recover();

		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 7, from: "running", to: "pending" },
		]);
	});

	it("still cleans up stale DB runs when tracker fetch fails", async () => {
		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, db, tracker } = ctx;
		tracker.failNextFetchActiveIssues();

		seedStaleRun(db);

		await orchestrator.recover();

		const all = db.select().from(runs).all();
		expect(all[0]?.status).toBe("failed");
	});

	it("does not fetch tracker 'running' issues during a tick", async () => {
		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, tracker } = ctx;

		await orchestrator.tick();

		expect(tracker.fetchCalls).toEqual(["pending"]);
	});
});
