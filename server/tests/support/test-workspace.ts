import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

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
			return wsPath;
		},
		async [Symbol.asyncDispose]() {
			await rm(root, { recursive: true, force: true });
		},
	};
}
