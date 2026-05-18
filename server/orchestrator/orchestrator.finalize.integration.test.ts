import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
	noopAgent,
	REPO,
	syntheticSuccessResult,
	type TestRunAgent,
} from "../test-support/fixtures.ts";
import { createTestOrchestrator } from "../test-support/test-orchestrator.ts";

const exec = promisify(execFile);

async function listRemoteBranches(barePath: string): Promise<string[]> {
	const { stdout } = await exec("git", ["branch", "--list"], { cwd: barePath });
	return stdout
		.split("\n")
		.map((line) => line.replace(/^[*+ ]+/, "").trim())
		.filter(Boolean);
}

// Simulates push failure by breaking origin from inside the agent step, after
// the orchestrator has already cloned a fresh workspace.
async function* breakRemoteAgent({
	options,
}: Parameters<TestRunAgent>[0]): ReturnType<TestRunAgent> {
	const cwd = options?.cwd;
	if (typeof cwd === "string") {
		await exec(
			"git",
			["remote", "set-url", "origin", "/nonexistent/path.git"],
			{ cwd },
		);
	}
	yield syntheticSuccessResult();
}

describe("Orchestrator success-path finalization", () => {
	it("pushes the agent's branch to the remote before opening the change request", async () => {
		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const {
			orchestrator,
			runner,
			workspace,
			tracker,
			codeHost,
			repo: runRepo,
		} = ctx;
		tracker.addIssue("pending", { number: 11, repo: REPO });

		await orchestrator.tick();
		await runner.waitForIdle();
		await orchestrator.settled();

		const remoteBranches = await listRemoteBranches(
			workspace.bareRemotePath(REPO),
		);
		expect(remoteBranches).toContain("agent/issue-11");
		expect(codeHost.changeRequests.map((c) => c.repo)).toEqual([REPO]);
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 11, from: "pending", to: "running" },
			{ repo: REPO, number: 11, from: "running", to: "awaiting_review" },
		]);
		const [run] = runRepo.getRuns({ limit: 1 });
		if (run?.workspaceDir == null) throw new Error("expected workspaceDir");
		await expect(access(run.workspaceDir)).rejects.toThrow();
	});

	it("skips MR creation and tracker transition when the push fails, and marks the issue failed", async () => {
		await using ctx = await createTestOrchestrator({
			runAgent: breakRemoteAgent,
		});
		const { orchestrator, runner, tracker, codeHost } = ctx;
		tracker.addIssue("pending", { number: 12, repo: REPO });

		await orchestrator.tick();
		await runner.waitForIdle();
		await orchestrator.settled();

		expect(codeHost.changeRequests).toEqual([]);
		expect(tracker.transitions).toEqual([
			{ repo: REPO, number: 12, from: "pending", to: "running" },
		]);
		expect(tracker.markedFailed).toEqual([{ repo: REPO, number: 12 }]);
	});

	it("marks the run failed with finalizeFailure when push fails", async () => {
		await using ctx = await createTestOrchestrator({
			runAgent: breakRemoteAgent,
		});
		const { orchestrator, runner, repo: runRepo } = ctx;
		ctx.tracker.addIssue("pending", { number: 13, repo: REPO });

		await orchestrator.tick();
		await runner.waitForIdle();
		await orchestrator.settled();

		const [run] = runRepo.getRuns({ limit: 1 });
		if (run?.status !== "failed") throw new Error("expected failed run");
		expect(run.finalizeFailure?.phase).toBe("push");
		expect(run.finalizeFailure?.error).toMatch(/git push/);
		// stderr must survive the round-trip through finalizeFailure — Node's
		// execFile errors carry the diagnostic detail on `err.stderr`, not in
		// `err.message`. The broken origin URL makes git emit a "does not appear
		// to be a git repository" / "Could not read from remote" line on stderr.
		expect(run.finalizeFailure?.error).toMatch(/stderr:/);
		expect(run.finalizeFailure?.error).toMatch(
			/does not appear to be a git repository|Could not read from remote/,
		);
		expect(run.error).toMatch(/^push: /);

		const systemEvents = runRepo
			.getRunEvents(run.id)
			.filter((e) => e.kind === "system");
		expect(
			systemEvents.some((e) => e.data.message === "finalize failed: push"),
		).toBe(true);
	});
});
