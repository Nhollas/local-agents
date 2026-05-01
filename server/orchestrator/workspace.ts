import { execFile } from "node:child_process";
import { access, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../trackers/types.ts";

const exec = promisify(execFile);

export type RunShell = (script: string, cwd: string) => Promise<void>;

export const realRunShell: RunShell = async (script, cwd) => {
	await exec("sh", ["-c", script], { cwd });
};

export function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function ensureWorkspace(
	issue: Issue,
	workspaceRoot: string,
	cloneUrl: string,
): Promise<{ path: string; created: boolean }> {
	const dirName = sanitizeKey(issue.key);
	const wsPath = join(workspaceRoot, dirName);

	try {
		await access(wsPath);
		return { path: wsPath, created: false };
	} catch {}

	await mkdir(wsPath, { recursive: true });
	await exec("git", ["clone", cloneUrl, "."], { cwd: wsPath });

	return { path: wsPath, created: true };
}

export async function ensureBranch(
	wsPath: string,
	branch: string,
): Promise<void> {
	await exec("git", ["checkout", "-B", branch], { cwd: wsPath });
}

export async function removeWorkspace(wsPath: string): Promise<void> {
	await rm(wsPath, { recursive: true, force: true });
}

const SETUP_SCRIPT_PATH = ".agent/setup.sh";

export async function runRepoSetup(
	wsPath: string,
	runShell: RunShell,
): Promise<void> {
	const scriptPath = join(wsPath, SETUP_SCRIPT_PATH);
	try {
		await access(scriptPath);
	} catch {
		return;
	}

	await runShell(`bash ${SETUP_SCRIPT_PATH}`, wsPath);
}
