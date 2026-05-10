import { describe, expect, it } from "vitest";
import { hangingAgent, jiraIssueKey, REPO } from "../test-support/fixtures.ts";
import { createTestOrchestrator } from "../test-support/test-orchestrator.ts";

describe("Orchestrator holding queue", () => {
	it("captures pending issues with first-seen pendingSince and clears them on dispatch", async () => {
		await using ctx = await createTestOrchestrator({
			configOverrides: { max_concurrent: 1 },
			runAgent: hangingAgent,
		});
		const { orchestrator, workspace, tracker } = ctx;

		tracker.addIssue("pending", {
			number: 1,
			repo: REPO,
			title: "issue one",
			createdAt: "2025-01-01T00:00:00.000+0000",
		});
		tracker.addIssue("pending", {
			number: 2,
			repo: REPO,
			title: "issue two",
			createdAt: "2025-01-02T00:00:00.000+0000",
		});
		await workspace.preCreateWorkspace(jiraIssueKey(1));
		await workspace.preCreateWorkspace(jiraIssueKey(2));

		await orchestrator.tick();

		expect(orchestrator.getQueueSnapshot()).toEqual([
			{
				issueKey: jiraIssueKey(2),
				issueTitle: "issue two",
				repo: REPO,
				pendingSince: expect.any(String),
			},
		]);
	});

	it("preserves pendingSince across ticks for issues that stay pending", async () => {
		await using ctx = await createTestOrchestrator({
			configOverrides: { max_concurrent: 0 },
		});
		const { orchestrator, tracker } = ctx;

		tracker.addIssue("pending", {
			number: 7,
			repo: REPO,
			title: "stays pending",
		});

		await orchestrator.tick();
		const first = orchestrator.getQueueSnapshot();
		expect(first).toEqual([
			{
				issueKey: jiraIssueKey(7),
				issueTitle: "stays pending",
				repo: REPO,
				pendingSince: expect.any(String),
			},
		]);

		// A later tick must not bump pendingSince forward.
		await new Promise((r) => setTimeout(r, 5));
		await orchestrator.tick();
		const second = orchestrator.getQueueSnapshot();
		expect(second[0]?.pendingSince).toBe(first[0]?.pendingSince);
	});

	it("removes issues from the queue when the tracker stops reporting them as pending", async () => {
		await using ctx = await createTestOrchestrator({
			configOverrides: { max_concurrent: 0 },
		});
		const { orchestrator, tracker } = ctx;

		tracker.addIssue("pending", { number: 11, repo: REPO });
		tracker.addIssue("pending", { number: 12, repo: REPO });
		await orchestrator.tick();
		expect(orchestrator.getQueueSnapshot()).toHaveLength(2);

		tracker.removeIssue("pending", 11);
		await orchestrator.tick();
		expect(orchestrator.getQueueSnapshot()).toEqual([
			expect.objectContaining({ issueKey: jiraIssueKey(12) }),
		]);
	});

	it("does not write DB rows for queued items", async () => {
		await using ctx = await createTestOrchestrator({
			configOverrides: { max_concurrent: 0 },
		});
		const { orchestrator, db, tracker } = ctx;
		const { runs } = await import("../db/schema.ts");

		tracker.addIssue("pending", { number: 21, repo: REPO });
		tracker.addIssue("pending", { number: 22, repo: REPO });
		await orchestrator.tick();

		expect(orchestrator.getQueueSnapshot()).toHaveLength(2);
		expect(db.select().from(runs).all()).toEqual([]);
	});
});
