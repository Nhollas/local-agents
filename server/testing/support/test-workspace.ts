import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitizeKey } from "../../orchestrator/workspace.ts";

const exec = promisify(execFile);

type TestWorkspace = {
	root: string;
	preCreateWorkspace(issueKey: string): Promise<string>;
	[Symbol.asyncDispose](): Promise<void>;
};

export async function createTestWorkspaceRoot(): Promise<TestWorkspace> {
	const root = join(
		tmpdir(),
		`local-agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await mkdir(root, { recursive: true });

	return {
		root,
		async preCreateWorkspace(issueKey: string): Promise<string> {
			const wsPath = join(root, sanitizeKey(issueKey));
			await mkdir(wsPath, { recursive: true });
			await exec("git", ["init", "--initial-branch=main"], { cwd: wsPath });
			await exec("git", ["config", "user.email", "test@example.test"], {
				cwd: wsPath,
			});
			await exec("git", ["config", "user.name", "Test"], { cwd: wsPath });
			await exec("git", ["commit", "--allow-empty", "-m", "seed"], {
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
