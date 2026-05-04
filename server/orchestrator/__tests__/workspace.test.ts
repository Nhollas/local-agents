import { execFile } from "node:child_process";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../../types/brands.ts";
import {
	ensureWorkspace,
	pushBranch,
	realRunShell,
	removeWorkspace,
	runRepoSetup,
} from "../workspace.ts";

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
	await exec("git", ["init", "--bare", "--initial-branch=main", bareRepo]);

	// Seed the bare with an initial main commit so subsequent clones have a
	// usable starting point. Without this, ensureWorkspace clones an empty
	// repo and tests can't `git checkout main`.
	const seedDir = join(
		tmpdir(),
		`bare-seed-${Math.random().toString(36).slice(2, 8)}`,
	);
	await exec("git", ["clone", bareRepo, seedDir]);
	await exec("git", ["config", "user.email", "test@example.test"], {
		cwd: seedDir,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: seedDir });
	await exec("git", ["commit", "--allow-empty", "-m", "seed"], {
		cwd: seedDir,
	});
	await exec("git", ["push", "origin", "main"], { cwd: seedDir });
	await rm(seedDir, { recursive: true, force: true });
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

describe("ensureWorkspace", () => {
	it("returns created: false when workspace already exists", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(1);

		const first = await ensureWorkspace(issue, ws.root, bareRepo);
		expect(first.created).toBe(true);

		const second = await ensureWorkspace(issue, ws.root, bareRepo);
		expect(second.created).toBe(false);
		expect(second.path).toBe(first.path);
	});
});

describe("pushBranch", () => {
	it("force-pushes the branch to origin so the remote tip matches local HEAD", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(7);
		const { path: wsPath } = await ensureWorkspace(issue, ws.root, bareRepo);
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
		const { path: wsPath } = await ensureWorkspace(issue, ws.root, bareRepo);
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: wsPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: wsPath });

		// First attempt's branch lands on the remote.
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: wsPath });
		await exec("git", ["commit", "--allow-empty", "-m", "first attempt"], {
			cwd: wsPath,
		});
		await pushBranch(wsPath, "agent/issue-8");
		const { stdout: firstSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: wsPath,
		});

		// Second attempt: a fresh workspace, branch reset from main, different commit.
		await exec("git", ["checkout", "main"], { cwd: wsPath });
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: wsPath });
		await exec("git", ["commit", "--allow-empty", "-m", "second attempt"], {
			cwd: wsPath,
		});
		await pushBranch(wsPath, "agent/issue-8");

		const { stdout: secondSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: wsPath,
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
		const { path: wsPath } = await ensureWorkspace(issue, ws.root, bareRepo);
		await exec(
			"git",
			["remote", "set-url", "origin", "/nonexistent/path.git"],
			{
				cwd: wsPath,
			},
		);
		await exec("git", ["checkout", "-B", "agent/issue-9"], { cwd: wsPath });

		await expect(pushBranch(wsPath, "agent/issue-9")).rejects.toThrow();
	});
});

describe("removeWorkspace", () => {
	it("deletes the workspace directory", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(4);

		const { path: wsPath } = await ensureWorkspace(issue, ws.root, bareRepo);

		await removeWorkspace(wsPath);
		await expect(access(wsPath)).rejects.toThrow();
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
