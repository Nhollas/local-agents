import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitizeKey } from "../../orchestrator/workspace.ts";

const exec = promisify(execFile);

// brokenRemote: point origin at a missing path so `git push` fails — used to
// exercise the lifecycle's push-failure path without needing real network.
type PreCreateOptions = {
	brokenRemote?: boolean;
};

type TestWorkspace = {
	root: string;
	preCreateWorkspace(
		issueKey: string,
		options?: PreCreateOptions,
	): Promise<string>;
	bareRemotePath(issueKey: string): string;
	[Symbol.asyncDispose](): Promise<void>;
};

export async function createTestWorkspaceRoot(): Promise<TestWorkspace> {
	const root = join(
		tmpdir(),
		`local-agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const remotesRoot = join(root, "__remotes__");
	await mkdir(remotesRoot, { recursive: true });

	function bareRemotePath(issueKey: string): string {
		return join(remotesRoot, `${sanitizeKey(issueKey)}.git`);
	}

	return {
		root,
		bareRemotePath,
		async preCreateWorkspace(
			issueKey: string,
			options: PreCreateOptions = {},
		): Promise<string> {
			const wsPath = join(root, sanitizeKey(issueKey));
			await mkdir(wsPath, { recursive: true });

			const bare = bareRemotePath(issueKey);
			await exec("git", ["init", "--bare", "--initial-branch=main", bare]);

			await exec("git", ["init", "--initial-branch=main"], { cwd: wsPath });
			await exec("git", ["config", "user.email", "test@example.test"], {
				cwd: wsPath,
			});
			await exec("git", ["config", "user.name", "Test"], { cwd: wsPath });
			await exec("git", ["commit", "--allow-empty", "-m", "seed"], {
				cwd: wsPath,
			});

			const remoteUrl = options.brokenRemote
				? join(root, "__nonexistent__", `${sanitizeKey(issueKey)}.git`)
				: bare;
			await exec("git", ["remote", "add", "origin", remoteUrl], {
				cwd: wsPath,
			});

			return wsPath;
		},
		async [Symbol.asyncDispose]() {
			// maxRetries tolerates a tail of git i/o from a killed agent's
			// ensureBranch racing with the rm.
			await rm(root, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 25,
			});
		},
	};
}
