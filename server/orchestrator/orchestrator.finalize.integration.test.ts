import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { jiraIssueKey, noopAgent, REPO } from "../test-support/fixtures.ts";
import { createTestOrchestrator } from "../test-support/test-orchestrator.ts";

const exec = promisify(execFile);

async function listRemoteBranches(barePath: string): Promise<string[]> {
	const { stdout } = await exec("git", ["branch", "--list"], { cwd: barePath });
	return stdout
		.split("\n")
		.map((line) => line.replace(/^[*+ ]+/, "").trim())
		.filter(Boolean);
}

describe("Orchestrator success-path finalization", () => {
	it("pushes the agent's branch to the remote before opening the change request", async () => {
		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const { orchestrator, runner, workspace, tracker, codeHost } = ctx;
		tracker.addIssue("pending", { number: 11, repo: REPO });
		const issueKey = jiraIssueKey(11);
		const wsPath = await workspace.preCreateWorkspace(issueKey);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const remoteBranches = await listRemoteBranches(
			workspace.bareRemotePath(issueKey),
		);
		expect(remoteBranches).toContain("agent/issue-11");
		expect(codeHost.changeRequests.map((c) => c.repo)).toEqual([REPO]);
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 11, from: "pending", to: "running" },
			{ repo: REPO, number: 11, from: "running", to: "awaiting_review" },
		]);
		await expect(access(wsPath)).rejects.toThrow();
	});

	it("skips MR creation and tracker transition when the push fails, and marks the issue failed", async () => {
		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const { orchestrator, runner, workspace, tracker, codeHost } = ctx;
		tracker.addIssue("pending", { number: 12, repo: REPO });
		const issueKey = jiraIssueKey(12);
		const wsPath = await workspace.preCreateWorkspace(issueKey, {
			brokenRemote: true,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(codeHost.changeRequests).toEqual([]);
		await expect(access(wsPath)).resolves.toBeUndefined();
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 12, from: "pending", to: "running" },
		]);
		expect(tracker.markedFailed).toEqual([{ repo: REPO, number: 12 }]);
	});
});
