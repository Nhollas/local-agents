import { execFile } from "node:child_process";
import { access, chmod, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBareRepoMain } from "../test-support/test-workspace.ts";
import type { Issue } from "../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../types/brands.ts";
import {
	createWorkspace,
	pushBranch,
	realRunShell,
	removeWorkspace,
	runRepoSetup,
	sweepWorkspaces,
} from "./workspace.ts";

const exec = promisify(execFile);

function createIssue(num: number): Issue {
	return {
		key: issueKey(`test-owner/test-repo#${num}`),
		number: issueNumber(num),
		repo: repoSlug("test-owner/test-repo"),
		title: `Issue ${num}`,
		description: "",
		labels: [],
		url: "",
		createdAt: "",
	};
}

let bareRepo: string;

beforeAll(async () => {
	bareRepo = join(
		tmpdir(),
		`test-bare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.git`,
	);
	// Seed the bare with an initial main commit so createWorkspace clones
	// a repo where `git checkout main` works.
	await seedBareRepoMain(bareRepo);
});

afterAll(async () => {
	await rm(bareRepo, { recursive: true, force: true });
});

async function createWorkspaceRoot() {
	const root = join(
		tmpdir(),
		`ws-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	return {
		root,
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true });
		},
	};
}

describe("createWorkspace", () => {
	it("creates a per-run directory named <issueKey>-<runId> with a fresh clone", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(1);

		const path = await createWorkspace(issue, ws.root, bareRepo, "run-abc");

		expect(path).toBe(join(ws.root, "test-owner_test-repo_1-run-abc"));
		await expect(access(join(path, ".git"))).resolves.toBeUndefined();
	});

	it("creates a distinct directory per run so prior runs cannot be inherited", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(2);

		const first = await createWorkspace(issue, ws.root, bareRepo, "run-1");
		await writeFile(join(first, "leftover.txt"), "from prior run");

		const second = await createWorkspace(issue, ws.root, bareRepo, "run-2");

		expect(second).not.toBe(first);
		await expect(access(join(second, "leftover.txt"))).rejects.toThrow();
		await expect(access(join(first, "leftover.txt"))).resolves.toBeUndefined();
	});
});

describe("pushBranch", () => {
	it("force-pushes the branch to origin so the remote tip matches local HEAD", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(7);
		const wsPath = await createWorkspace(issue, ws.root, bareRepo, "run-7");
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: wsPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: wsPath });
		await exec("git", ["checkout", "-B", "agent/issue-7"], { cwd: wsPath });
		await exec("git", ["commit", "--allow-empty", "-m", "agent commit"], {
			cwd: wsPath,
		});

		await pushBranch(wsPath, "agent/issue-7");

		const { stdout: localSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: wsPath,
		});
		const { stdout: remoteSha } = await exec(
			"git",
			["rev-parse", "agent/issue-7"],
			{ cwd: bareRepo },
		);
		expect(remoteSha.trim()).toBe(localSha.trim());
	});

	it("overwrites a divergent branch on the remote (re-run reuses the branch name)", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(8);
		const firstPath = await createWorkspace(issue, ws.root, bareRepo, "run-a");
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: firstPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: firstPath });
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: firstPath });
		await exec("git", ["commit", "--allow-empty", "-m", "first attempt"], {
			cwd: firstPath,
		});
		await pushBranch(firstPath, "agent/issue-8");
		const { stdout: firstSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: firstPath,
		});

		const secondPath = await createWorkspace(issue, ws.root, bareRepo, "run-b");
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: secondPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: secondPath });
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: secondPath });
		await exec("git", ["commit", "--allow-empty", "-m", "second attempt"], {
			cwd: secondPath,
		});
		await pushBranch(secondPath, "agent/issue-8");

		const { stdout: secondSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: secondPath,
		});
		const { stdout: remoteSha } = await exec(
			"git",
			["rev-parse", "agent/issue-8"],
			{ cwd: bareRepo },
		);
		expect(secondSha.trim()).not.toBe(firstSha.trim());
		expect(remoteSha.trim()).toBe(secondSha.trim());
	});

	it("rejects when the remote is unreachable", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(9);
		const wsPath = await createWorkspace(issue, ws.root, bareRepo, "run-9");
		await exec(
			"git",
			["remote", "set-url", "origin", "/nonexistent/path.git"],
			{ cwd: wsPath },
		);
		await exec("git", ["checkout", "-B", "agent/issue-9"], { cwd: wsPath });

		await expect(pushBranch(wsPath, "agent/issue-9")).rejects.toThrow();
	});
});

describe("removeWorkspace", () => {
	it("deletes the workspace directory", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(4);

		const wsPath = await createWorkspace(issue, ws.root, bareRepo, "run-4");

		await removeWorkspace(wsPath);
		await expect(access(wsPath)).rejects.toThrow();
	});
});

describe("sweepWorkspaces", () => {
	it("removes workspace directories older than the TTL and leaves recent ones", async () => {
		await using ws = await createWorkspaceRoot();
		await mkdir(ws.root, { recursive: true });

		const stale = join(ws.root, "stale-run");
		const fresh = join(ws.root, "fresh-run");
		await mkdir(stale);
		await mkdir(fresh);

		const now = Date.now();
		const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
		await utimes(stale, eightDaysAgo, eightDaysAgo);

		const result = await sweepWorkspaces(ws.root, 7 * 24 * 60 * 60 * 1000, now);

		expect(result.removed).toEqual([stale]);
		await expect(access(stale)).rejects.toThrow();
		await expect(access(fresh)).resolves.toBeUndefined();
	});

	it("returns no removals when the workspace root does not yet exist", async () => {
		const path = join(
			tmpdir(),
			`ws-missing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		const result = await sweepWorkspaces(path, 1000);

		expect(result.removed).toEqual([]);
	});
});

async function withWorkspace(): Promise<{
	path: string;
	[Symbol.asyncDispose](): Promise<void>;
}> {
	const path = join(
		tmpdir(),
		`ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await mkdir(path, { recursive: true });
	return {
		path,
		async [Symbol.asyncDispose]() {
			await rm(path, { recursive: true, force: true });
		},
	};
}

async function writeSetupScript(wsPath: string, body: string) {
	await mkdir(join(wsPath, ".agent"), { recursive: true });
	const scriptPath = join(wsPath, ".agent", "setup.sh");
	await writeFile(scriptPath, body);
	await chmod(scriptPath, 0o755);
}

describe("runRepoSetup", () => {
	it("invokes the script via the runShell when present", async () => {
		await using ws = await withWorkspace();
		await writeSetupScript(ws.path, "#!/usr/bin/env bash\necho hi\n");

		const calls: { script: string; cwd: string }[] = [];
		await runRepoSetup(ws.path, async (script, cwd) => {
			calls.push({ script, cwd });
		});

		expect(calls).toEqual([{ script: "bash .agent/setup.sh", cwd: ws.path }]);
	});

	it("realRunShell executes the script in the workspace and a non-zero exit rejects", async () => {
		await using ws = await withWorkspace();
		await writeSetupScript(
			ws.path,
			"#!/usr/bin/env bash\necho ok > setup_output\n",
		);

		await runRepoSetup(ws.path, realRunShell);

		await expect(
			access(join(ws.path, "setup_output")),
		).resolves.toBeUndefined();

		// Non-zero exit propagates as a rejection from realRunShell.
		await writeSetupScript(ws.path, "#!/usr/bin/env bash\nexit 1\n");
		await expect(runRepoSetup(ws.path, realRunShell)).rejects.toThrow();
	});

	it("is a no-op when the script is absent", async () => {
		await using ws = await withWorkspace();
		const calls: { script: string; cwd: string }[] = [];

		await runRepoSetup(ws.path, async (script, cwd) => {
			calls.push({ script, cwd });
		});

		expect(calls).toEqual([]);
	});

	it("rethrows when the runShell rejects", async () => {
		await using ws = await withWorkspace();
		await writeSetupScript(ws.path, "#!/usr/bin/env bash\nexit 1\n");

		await expect(
			runRepoSetup(ws.path, async () => {
				throw new Error("setup.sh exit 1");
			}),
		).rejects.toThrow(/setup.sh exit 1/);
	});
});
