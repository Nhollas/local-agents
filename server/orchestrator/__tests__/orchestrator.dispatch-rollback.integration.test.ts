import { describe, expect, it } from "vitest";
import { createGitHubIssue } from "../../testing/support/fixtures.ts";
import { githubHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

describe("Orchestrator dispatch label rollback", () => {
	it("recovers an issue stuck with agent:running label but no DB record", async () => {
		const labelOps: { method: string; label: string }[] = [];

		// Issue has "agent:running" in GitHub but there is no run in the DB.
		// This is the aftermath of a failed dispatch where the rollback also failed.
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

		await using ctx = await createTestOrchestrator();
		const { orchestrator, runner } = ctx;

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
