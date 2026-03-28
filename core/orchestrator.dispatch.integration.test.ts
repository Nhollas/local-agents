import { describe, expect, it } from "vitest";
import {
	createGitHubIssue,
	createTestWorkflow,
	hangingAgent,
	noopAgent,
	REPO,
} from "../tests/support/fixtures.ts";
import { githubHandlers, server } from "../tests/support/msw.ts";
import { createTestConfig } from "../tests/support/test-config.ts";
import { createTestDb } from "../tests/support/test-db.ts";
import { createTestWorkspaceRoot } from "../tests/support/test-workspace.ts";
import { githubCodeHostAdapter } from "./code-hosts/github.ts";
import { createGitHubClient } from "./gh.ts";
import { createOrchestrator } from "./orchestrator.ts";
import { createRunner } from "./runner.ts";
import { runs } from "./schema.ts";
import { githubTrackerAdapter } from "./trackers/github.ts";
import type { RepoWorkflow } from "./types.ts";

describe("Orchestrator dispatch", () => {
	it("dispatches agent for a pending issue, swaps label, and creates DB record", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(1, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#1`);

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

		expect(labelOps).toContainEqual({ method: "delete", label: "agent" });
		expect(labelOps).toContainEqual({ method: "add", label: "agent:running" });

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].agentName).toBe("issue-1");
		expect(allRuns[0].issueKey).toBe(`${REPO}#1`);
	});

	it("creates PR and swaps to awaiting-review on successful completion", async () => {
		const labelOps: { method: string; label: string }[] = [];

		server.use(
			...githubHandlers({
				issues: [createGitHubIssue(5, ["agent"])],
				onLabelDelete: (label) => labelOps.push({ method: "delete", label }),
				onLabelAdd: (label) => labelOps.push({ method: "add", label }),
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		await workspace.preCreateWorkspace(`${REPO}#5`);

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

		expect(labelOps).toContainEqual({
			method: "delete",
			label: "agent:running",
		});
		expect(labelOps).toContainEqual({
			method: "add",
			label: "agent:awaiting-review",
		});
	});

	it("respects max_concurrent limit", async () => {
		server.use(
			...githubHandlers({
				issues: [
					createGitHubIssue(1, ["agent"], "2025-01-01T00:00:00Z"),
					createGitHubIssue(2, ["agent"], "2025-01-02T00:00:00Z"),
					createGitHubIssue(3, ["agent"], "2025-01-03T00:00:00Z"),
				],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		for (const num of [1, 2, 3]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 1,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: hangingAgent,
		});

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		expect(allRuns).toHaveLength(1);
		expect(allRuns[0].agentName).toBe("issue-1");
	});

	it("dispatches oldest issues first", async () => {
		server.use(
			...githubHandlers({
				issues: [
					createGitHubIssue(99, ["agent"], "2025-01-03T00:00:00Z"),
					createGitHubIssue(42, ["agent"], "2025-01-01T00:00:00Z"),
					createGitHubIssue(77, ["agent"], "2025-01-02T00:00:00Z"),
				],
			}),
		);

		await using workspace = await createTestWorkspaceRoot();
		for (const num of [42, 77, 99]) {
			await workspace.preCreateWorkspace(`${REPO}#${num}`);
		}

		const db = createTestDb();
		const github = createGitHubClient("test-token");
		const runner = createRunner({ db, maxConcurrency: 5 });

		const orchestrator = createOrchestrator({
			db,
			tracker: githubTrackerAdapter(github),
			codeHost: githubCodeHostAdapter(github),
			config: createTestConfig({
				workspace_root: workspace.root,
				max_concurrent: 2,
			}),
			workflows: new Map<string, RepoWorkflow>([[REPO, createTestWorkflow()]]),
			runner,
			runAgent: noopAgent,
		});

		await orchestrator.tick();

		const allRuns = db.select().from(runs).all();
		const dispatched = allRuns.map((r) => r.agentName);
		expect(dispatched).toEqual(["issue-42", "issue-77"]);
	});
});
