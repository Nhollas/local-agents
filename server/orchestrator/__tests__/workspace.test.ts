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
	await exec("git", ["init", "--bare", bareRepo]);
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
