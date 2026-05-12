import { execFile } from "node:child_process";
import { access, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../trackers/types.ts";

const exec = promisify(execFile);

export type RunShell = (
	script: string,
	cwd: string,
	env: Record<string, string>,
) => Promise<void>;

export const realRunShell: RunShell = async (script, cwd, env) => {
	await exec("sh", ["-c", script], { cwd, env });
};

export function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function createWorkspace(
	issue: Issue,
	workspaceRoot: string,
	cloneUrl: string,
	runId: string,
): Promise<string> {
	const dirName = `${sanitizeKey(issue.key)}-${runId}`;
	const wsPath = join(workspaceRoot, dirName);

	await mkdir(wsPath, { recursive: true });
	await exec("git", ["clone", cloneUrl, "."], { cwd: wsPath });

	return wsPath;
}

export async function ensureBranch(
	wsPath: string,
	branch: string,
): Promise<void> {
	await exec("git", ["checkout", "-B", branch], { cwd: wsPath });
}

export async function pushBranch(
	wsPath: string,
	branch: string,
): Promise<void> {
	// Force-push because re-runs of the same issue reuse the branch name and
	// the agent's commits are the authoritative attempt for that run.
	await exec("git", ["push", "--force", "origin", branch], { cwd: wsPath });
}

export async function removeWorkspace(wsPath: string): Promise<void> {
	// maxRetries tolerates a tail of git i/o (e.g. from a killed agent whose
	// ensureBranch was still settling) racing with the rm.
	await rm(wsPath, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 25,
	});
}

// Delete workspace directories older than `maxAgeMs`. Workspaces are kept on
// failure for forensics, so without a sweep they'd accumulate indefinitely.
export async function sweepWorkspaces(
	workspaceRoot: string,
	maxAgeMs: number,
	now: number = Date.now(),
): Promise<{ removed: string[] }> {
	let entries: string[];
	try {
		entries = await readdir(workspaceRoot);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { removed: [] };
		}
		throw err;
	}

	const removed: string[] = [];
	for (const entry of entries) {
		const path = join(workspaceRoot, entry);
		const info = await stat(path).catch(() => null);
		if (!info?.isDirectory()) continue;
		if (now - info.mtimeMs < maxAgeMs) continue;
		await removeWorkspace(path);
		removed.push(path);
	}
	return { removed };
}

const SETUP_SCRIPT_PATH = ".agent/setup.sh";

export async function runRepoSetup(
	wsPath: string,
	runShell: RunShell,
	env: Record<string, string>,
): Promise<boolean> {
	const scriptPath = join(wsPath, SETUP_SCRIPT_PATH);
	try {
		await access(scriptPath);
	} catch {
		return false;
	}

	await runShell(`bash ${SETUP_SCRIPT_PATH}`, wsPath, env);
	return true;
}
