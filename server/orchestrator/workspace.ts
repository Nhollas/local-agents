import { execFile } from "node:child_process";
import {
	access,
	appendFile,
	chmod,
	cp,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Issue } from "../trackers/types.ts";
import { renderPrompt } from "../workflow/workflow.ts";

const exec = promisify(execFile);

export type RunShell = (
	script: string,
	cwd: string,
	env: Record<string, string>,
) => Promise<void>;

export const realRunShell: RunShell = async (script, cwd, env) => {
	await exec("sh", ["-c", script], { cwd, env });
};

const ACTIVATE_NODE_VERSION_SCRIPT = `
if [ -f .nvmrc ]; then
  node_version="$(tr -d '[:space:]' < .nvmrc)"

  if ! command -v fnm >/dev/null 2>&1; then
    echo "Target repo declares .nvmrc but fnm is not available on PATH. Install fnm before running local-agents." >&2
    exit 1
  fi

  eval "$(fnm env --shell bash)"
  fnm use --install-if-missing "$node_version" >/dev/null
fi

env -0
`.trim();

export async function resolveWorkspaceEnvironment(
	wsPath: string,
	baseEnv: Record<string, string>,
): Promise<Record<string, string>> {
	if (!(await pathExists(join(wsPath, ".nvmrc")))) return baseEnv;

	const { stdout } = await exec("bash", ["-c", ACTIVATE_NODE_VERSION_SCRIPT], {
		cwd: wsPath,
		env: baseEnv,
	});

	return parseNullDelimitedEnv(stdout);
}

export function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseNullDelimitedEnv(stdout: string): Record<string, string> {
	const env: Record<string, string> = {};

	for (const entry of stdout.split("\0")) {
		if (entry === "") continue;
		const equalsIndex = entry.indexOf("=");
		if (equalsIndex <= 0) continue;
		env[entry.slice(0, equalsIndex)] = entry.slice(equalsIndex + 1);
	}

	return env;
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	const info = await stat(path).catch(() => null);
	return info?.isDirectory() === true;
}

const WORKSPACE_SKILLS_DIR = ".claude/skills";

type SkillRenderVars = {
	issue: Issue;
	branch: string;
	base_branch: string;
};

// Target-repo wins on name collision: a skill committed under `.claude/skills/<name>`
// in the workspace overrides LA's bundled one. We only render `{{ var }}` in the
// copied .md files — Claude Code's own `!`cmd`` blocks still fire at skill-load time.
export async function installSkills(
	wsPath: string,
	skillsSourceDir: string,
	vars: SkillRenderVars,
): Promise<{ installed: string[]; skipped: string[] }> {
	let entries: string[];
	try {
		entries = await readdir(skillsSourceDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { installed: [], skipped: [] };
		}
		throw err;
	}

	const destRoot = join(wsPath, WORKSPACE_SKILLS_DIR);
	await mkdir(destRoot, { recursive: true });

	const installed: string[] = [];
	const skipped: string[] = [];

	for (const name of entries) {
		const source = join(skillsSourceDir, name);
		if (!(await isDirectory(source))) continue;

		const target = join(destRoot, name);
		if (await pathExists(target)) {
			skipped.push(name);
			continue;
		}
		await cp(source, target, { recursive: true });
		await renderMarkdownInPlace(target, vars);
		installed.push(name);
	}

	await appendToGitExclude(
		wsPath,
		installed.map((name) => `${WORKSPACE_SKILLS_DIR}/${name}/`),
	);

	return { installed, skipped };
}

const WORKSPACE_HOOKS_DIR = ".claude/hooks";
const WORKSPACE_SETTINGS_FILE = ".claude/settings.json";

// Hooks and settings are policy the orchestrator enforces, not skills the target
// repo can opt out of. We always overwrite — the agent must not be able to bypass
// the guardrails by committing a competing .claude/settings.json into its repo.
export async function installAgentDefaults(
	wsPath: string,
	hooksSourceDir: string,
	settingsSourceFile: string,
): Promise<{ hooksInstalled: string[]; settingsInstalled: boolean }> {
	const destHooks = join(wsPath, WORKSPACE_HOOKS_DIR);
	await mkdir(destHooks, { recursive: true });

	let entries: string[];
	try {
		entries = await readdir(hooksSourceDir);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			entries = [];
		} else {
			throw err;
		}
	}

	const hooksInstalled: string[] = [];
	for (const name of entries) {
		const source = join(hooksSourceDir, name);
		const info = await stat(source).catch(() => null);
		if (!info?.isFile()) continue;
		const target = join(destHooks, name);
		await cp(source, target);
		// Restore the exec bit — `cp` honours mode but some FS layouts (npm pack,
		// fat archives) can strip it. Hooks must be executable to fire.
		await chmod(target, 0o755);
		hooksInstalled.push(name);
	}

	await cp(settingsSourceFile, join(wsPath, WORKSPACE_SETTINGS_FILE));

	await appendToGitExclude(wsPath, [
		`${WORKSPACE_HOOKS_DIR}/`,
		WORKSPACE_SETTINGS_FILE,
	]);

	return { hooksInstalled, settingsInstalled: true };
}

// Per-clone exclude in .git/info/exclude — keeps orchestrator-injected files out
// of `git status` without writing a .gitignore the agent would see in the tree.
async function appendToGitExclude(
	wsPath: string,
	entries: string[],
): Promise<void> {
	const excludePath = join(wsPath, ".git", "info", "exclude");
	let existing: string;
	try {
		existing = await readFile(excludePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}

	const present = new Set(
		existing
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#")),
	);
	const toAppend = entries.filter((entry) => !present.has(entry));
	if (toAppend.length === 0) return;

	const prefix = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
	await appendFile(excludePath, `${prefix}${toAppend.join("\n")}\n`);
}

async function renderMarkdownInPlace(
	dir: string,
	vars: SkillRenderVars,
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await renderMarkdownInPlace(path, vars);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const source = await readFile(path, "utf8");
		const rendered = renderPrompt(source, vars);
		if (rendered !== source) {
			await writeFile(path, rendered);
		}
	}
}

const SETUP_SCRIPT_PATH = ".agent/setup.sh";

export async function runRepoSetup(
	wsPath: string,
	runShell: RunShell,
	env: Record<string, string>,
): Promise<boolean> {
	if (!(await pathExists(join(wsPath, SETUP_SCRIPT_PATH)))) return false;
	await runShell(`bash ${SETUP_SCRIPT_PATH}`, wsPath, env);
	return true;
}
