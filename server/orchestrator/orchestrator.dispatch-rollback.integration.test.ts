import { describe, expect, it } from "vitest";
import { githubCodeHostAdapter } from "../code-hosts/github.ts";
import { createGitHubClient } from "../github-client.ts";
import { createRunner } from "../runner/runner.ts";
import {
	createGitHubIssue,
	createTestWorkflow,
	noopAgent,
	REPO,
} from "../tests/support/fixtures.ts";
import { githubHandlers, server } from "../tests/support/msw.ts";
import { createTestConfig } from "../tests/support/test-config.ts";
import { createTestDb } from "../tests/support/test-db.ts";
import { createTestWorkspaceRoot } from "../tests/support/test-workspace.ts";
import { githubTrackerAdapter } from "../trackers/github.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { createOrchestrator } from "./orchestrator.ts";

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

		await using workspace = await createTestWorkspaceRoot();

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 2 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({ workspace_root: workspace.root }),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
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
