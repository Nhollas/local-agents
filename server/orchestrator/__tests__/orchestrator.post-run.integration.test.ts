import { describe, expect, it } from "vitest";
import {
	createGitHubIssue,
	noopAgent,
	REPO,
} from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator post-run recovery", () => {
	it("reconciles issue labeled agent:running in GitHub when DB run is already completed", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				resolveIssues: (label) => {
					if (label === "agent:running")
						return [createGitHubIssue(1, ["agent:running"])];
					return [];
				},
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
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

		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({ method: "add", label: "agent" });
	});
});
