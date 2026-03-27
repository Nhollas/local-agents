import { execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "./types.ts";
import { renderPrompt } from "./workflow.ts";

const exec = promisify(execFile);

function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function ensureWorkspace(
	issue: Issue,
	workspaceRoot: string,
	cloneUrl: string,
	hooks?: { after_create?: string },
): Promise<{ path: string; created: boolean }> {
	const dirName = sanitizeKey(issue.key);
	const wsPath = join(workspaceRoot, dirName);

	try {
		await access(wsPath);
		return { path: wsPath, created: false };
	} catch {
		// Directory doesn't exist — create it
	}

	await mkdir(wsPath, { recursive: true });
	await exec("git", ["clone", cloneUrl, "."], { cwd: wsPath });

	if (hooks?.after_create) {
		const script = renderPrompt(hooks.after_create, { issue });
		await exec("sh", ["-c", script], { cwd: wsPath });
	}

	return { path: wsPath, created: true };
}
