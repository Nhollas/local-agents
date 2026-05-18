import { join } from "node:path";
import {
	Command,
	type CommandExecutor,
	FileSystem,
	type Error as PlatformError,
} from "@effect/platform";
import { Data, Effect, Option, Stream } from "effect";
import type { Issue } from "../trackers/types.ts";
import { renderPrompt } from "../workflow/render-prompt.ts";

export class WorkspaceCommandError extends Data.TaggedError(
	"WorkspaceCommandError",
)<{
	readonly command: string;
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
}> {
	override get message(): string {
		return `${this.command} exited ${this.exitCode}`;
	}
}

export function sanitizeKey(key: string): string {
	return key.replace(/[^A-Za-z0-9._-]/g, "_");
}

export function createWorkspace(
	issue: Issue,
	workspaceRoot: string,
	cloneUrl: string,
	runId: string,
): Effect.Effect<
	string,
	PlatformError.PlatformError | WorkspaceCommandError,
	FileSystem.FileSystem | CommandExecutor.CommandExecutor
> {
	return Effect.gen(function* () {
		const dirName = `${sanitizeKey(issue.key)}-${runId}`;
		const wsPath = join(workspaceRoot, dirName);

		const fs = yield* FileSystem.FileSystem;
		yield* fs.makeDirectory(wsPath, { recursive: true });
		yield* runCommand(
			Command.make("git", "clone", cloneUrl, ".").pipe(
				Command.workingDirectory(wsPath),
			),
			`git clone ${cloneUrl}`,
		);
		return wsPath;
	});
}

export function ensureBranch(
	wsPath: string,
	branch: string,
): Effect.Effect<
	void,
	WorkspaceCommandError | PlatformError.PlatformError,
	CommandExecutor.CommandExecutor
> {
	return runCommand(
		Command.make("git", "checkout", "-B", branch).pipe(
			Command.workingDirectory(wsPath),
		),
		`git checkout -B ${branch}`,
	).pipe(Effect.asVoid);
}

// Force-push because re-runs of the same issue reuse the branch name and
// the agent's commits are the authoritative attempt for that run.
export function pushBranch(
	wsPath: string,
	branch: string,
): Effect.Effect<
	void,
	WorkspaceCommandError | PlatformError.PlatformError,
	CommandExecutor.CommandExecutor
> {
	return runCommand(
		Command.make("git", "push", "--force", "origin", branch).pipe(
			Command.workingDirectory(wsPath),
		),
		`git push --force origin ${branch}`,
	).pipe(Effect.asVoid);
}

export function removeWorkspace(
	wsPath: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		yield* fs.remove(wsPath, { recursive: true, force: true });
	});
}

// Delete workspace directories older than `maxAgeMs`. Workspaces are kept on
// failure for forensics, so without a sweep they'd accumulate indefinitely.
export function sweepWorkspaces(
	workspaceRoot: string,
	maxAgeMs: number,
	now: number = Date.now(),
): Effect.Effect<
	{ removed: string[] },
	PlatformError.PlatformError,
	FileSystem.FileSystem
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const entries = yield* fs
			.readDirectory(workspaceRoot)
			.pipe(
				Effect.catchTag("SystemError", (err) =>
					err.reason === "NotFound"
						? Effect.succeed<string[]>([])
						: Effect.fail(err),
				),
			);

		const removed: string[] = [];
		for (const entry of entries) {
			const path = join(workspaceRoot, entry);
			const info = yield* fs.stat(path).pipe(Effect.option);
			if (!Option.isSome(info)) continue;
			if (info.value.type !== "Directory") continue;
			const mtime = info.value.mtime;
			if (!Option.isSome(mtime)) continue;
			if (now - mtime.value.getTime() < maxAgeMs) continue;
			yield* fs.remove(path, { recursive: true, force: true });
			removed.push(path);
		}
		return { removed };
	});
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
export function installSkills(
	wsPath: string,
	skillsSourceDir: string,
	vars: SkillRenderVars,
): Effect.Effect<
	{ installed: string[]; skipped: string[] },
	PlatformError.PlatformError,
	FileSystem.FileSystem
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;

		const entries = yield* fs
			.readDirectory(skillsSourceDir)
			.pipe(
				Effect.catchTag("SystemError", (err) =>
					err.reason === "NotFound"
						? Effect.succeed<string[]>([])
						: Effect.fail(err),
				),
			);
		if (entries.length === 0) {
			return { installed: [], skipped: [] };
		}

		const destRoot = join(wsPath, WORKSPACE_SKILLS_DIR);
		yield* fs.makeDirectory(destRoot, { recursive: true });

		const installed: string[] = [];
		const skipped: string[] = [];

		for (const name of entries) {
			const source = join(skillsSourceDir, name);
			const sourceInfo = yield* fs.stat(source).pipe(Effect.option);
			if (!Option.isSome(sourceInfo)) continue;
			if (sourceInfo.value.type !== "Directory") continue;

			const target = join(destRoot, name);
			if (yield* fs.exists(target)) {
				skipped.push(name);
				continue;
			}
			yield* fs.copy(source, target);
			yield* renderMarkdownInPlace(target, vars);
			installed.push(name);
		}

		yield* appendToGitExclude(
			wsPath,
			installed.map((name) => `${WORKSPACE_SKILLS_DIR}/${name}/`),
		);

		return { installed, skipped };
	});
}

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

export function resolveWorkspaceEnvironment(
	wsPath: string,
	baseEnv: Record<string, string>,
): Effect.Effect<
	Record<string, string>,
	PlatformError.PlatformError | WorkspaceCommandError,
	FileSystem.FileSystem | CommandExecutor.CommandExecutor
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const hasNvmrc = yield* fs.exists(join(wsPath, ".nvmrc"));
		if (!hasNvmrc) return baseEnv;

		const stdout = yield* runCommand(
			Command.make("bash", "-c", ACTIVATE_NODE_VERSION_SCRIPT).pipe(
				Command.workingDirectory(wsPath),
				Command.env(baseEnv),
			),
			"bash -c <activate-node-version>",
		);
		return parseNullDelimitedEnv(stdout);
	});
}

const SETUP_SCRIPT_PATH = ".agent/setup.sh";

export function runRepoSetup(
	wsPath: string,
	env: Record<string, string>,
): Effect.Effect<
	boolean,
	PlatformError.PlatformError | WorkspaceCommandError,
	FileSystem.FileSystem | CommandExecutor.CommandExecutor
> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const present = yield* fs.exists(join(wsPath, SETUP_SCRIPT_PATH));
		if (!present) return false;
		yield* runCommand(
			Command.make("sh", "-c", `bash ${SETUP_SCRIPT_PATH}`).pipe(
				Command.workingDirectory(wsPath),
				Command.env(env),
			),
			`bash ${SETUP_SCRIPT_PATH}`,
		);
		return true;
	});
}

function runCommand(
	command: Command.Command,
	description: string,
): Effect.Effect<
	string,
	WorkspaceCommandError | PlatformError.PlatformError,
	CommandExecutor.CommandExecutor
> {
	return Effect.gen(function* () {
		const proc = yield* Command.start(command);
		const [stdout, stderr, exitCode] = yield* Effect.all(
			[
				Stream.decodeText(proc.stdout).pipe(Stream.mkString),
				Stream.decodeText(proc.stderr).pipe(Stream.mkString),
				proc.exitCode,
			],
			{ concurrency: "unbounded" },
		);
		if (exitCode !== 0) {
			return yield* new WorkspaceCommandError({
				command: description,
				exitCode,
				stderr,
				stdout,
			});
		}
		return stdout;
	}).pipe(Effect.scoped);
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

// Per-clone exclude in .git/info/exclude — keeps orchestrator-injected files out
// of `git status` without writing a .gitignore the agent would see in the tree.
function appendToGitExclude(
	wsPath: string,
	entries: string[],
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		if (entries.length === 0) return;
		const fs = yield* FileSystem.FileSystem;
		const excludePath = join(wsPath, ".git", "info", "exclude");

		const existing = yield* fs.readFileString(excludePath).pipe(
			Effect.map((s) => Option.some(s)),
			Effect.catchTag("SystemError", (err) =>
				err.reason === "NotFound"
					? Effect.succeed(Option.none<string>())
					: Effect.fail(err),
			),
		);
		if (!Option.isSome(existing)) return;

		const present = new Set(
			existing.value
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0 && !line.startsWith("#")),
		);
		const toAppend = entries.filter((entry) => !present.has(entry));
		if (toAppend.length === 0) return;

		const prefix =
			existing.value.length === 0 || existing.value.endsWith("\n") ? "" : "\n";
		yield* fs.writeFileString(
			excludePath,
			`${existing.value}${prefix}${toAppend.join("\n")}\n`,
		);
	});
}

function renderMarkdownInPlace(
	dir: string,
	vars: SkillRenderVars,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> {
	return Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const entries = yield* fs.readDirectory(dir);
		for (const name of entries) {
			const path = join(dir, name);
			const info = yield* fs.stat(path);
			if (info.type === "Directory") {
				yield* renderMarkdownInPlace(path, vars);
				continue;
			}
			if (info.type !== "File" || !name.endsWith(".md")) continue;
			const source = yield* fs.readFileString(path);
			const rendered = renderPrompt(source, vars);
			if (rendered !== source) {
				yield* fs.writeFileString(path, rendered);
			}
		}
	});
}
