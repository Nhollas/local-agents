import { execFile } from "node:child_process";
import {
	access,
	chmod,
	mkdir,
	readFile,
	rm,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedBareRepoMain } from "../test-support/test-workspace.ts";
import type { Issue } from "../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../types/brands.ts";
import { makeOrchestratorRuntime } from "./runtime.ts";
import {
	createWorkspace,
	installSkills,
	pushBranch,
	removeWorkspace,
	resolveWorkspaceEnvironment,
	runRepoSetup,
	sweepWorkspaces,
	WorkspaceCommandError,
} from "./workspace.ts";

const exec = promisify(execFile);

const runtime = makeOrchestratorRuntime();
const run = <A, E>(
	eff: Effect.Effect<
		A,
		E,
		Parameters<typeof runtime.runPromise>[0] extends Effect.Effect<
			unknown,
			unknown,
			infer R
		>
			? R
			: never
	>,
): Promise<A> => runtime.runPromise(eff as never) as Promise<A>;

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
	// Seed the bare with an initial main commit so createWorkspace clones
	// a repo where `git checkout main` works.
	await seedBareRepoMain(bareRepo);
});

afterAll(async () => {
	await rm(bareRepo, { recursive: true, force: true });
	await runtime.dispose();
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

describe("createWorkspace", () => {
	it("creates a per-run directory named <issueKey>-<runId> with a fresh clone", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(1);

		const path = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-abc"),
		);

		expect(path).toBe(join(ws.root, "test-owner_test-repo_1-run-abc"));
		await expect(access(join(path, ".git"))).resolves.toBeUndefined();
	});

	it("creates a distinct directory per run so prior runs cannot be inherited", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(2);

		const first = await run(createWorkspace(issue, ws.root, bareRepo, "run-1"));
		await writeFile(join(first, "leftover.txt"), "from prior run");

		const second = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-2"),
		);

		expect(second).not.toBe(first);
		await expect(access(join(second, "leftover.txt"))).rejects.toThrow();
		await expect(access(join(first, "leftover.txt"))).resolves.toBeUndefined();
	});
});

describe("pushBranch", () => {
	it("force-pushes the branch to origin so the remote tip matches local HEAD", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(7);
		const wsPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-7"),
		);
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: wsPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: wsPath });
		await exec("git", ["checkout", "-B", "agent/issue-7"], { cwd: wsPath });
		await exec("git", ["commit", "--allow-empty", "-m", "agent commit"], {
			cwd: wsPath,
		});

		await run(pushBranch(wsPath, "agent/issue-7"));

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
		const firstPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-a"),
		);
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: firstPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: firstPath });
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: firstPath });
		await exec("git", ["commit", "--allow-empty", "-m", "first attempt"], {
			cwd: firstPath,
		});
		await run(pushBranch(firstPath, "agent/issue-8"));
		const { stdout: firstSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: firstPath,
		});

		const secondPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-b"),
		);
		await exec("git", ["config", "user.email", "test@example.test"], {
			cwd: secondPath,
		});
		await exec("git", ["config", "user.name", "Test"], { cwd: secondPath });
		await exec("git", ["checkout", "-B", "agent/issue-8"], { cwd: secondPath });
		await exec("git", ["commit", "--allow-empty", "-m", "second attempt"], {
			cwd: secondPath,
		});
		await run(pushBranch(secondPath, "agent/issue-8"));

		const { stdout: secondSha } = await exec("git", ["rev-parse", "HEAD"], {
			cwd: secondPath,
		});
		const { stdout: remoteSha } = await exec(
			"git",
			["rev-parse", "agent/issue-8"],
			{ cwd: bareRepo },
		);
		expect(secondSha.trim()).not.toBe(firstSha.trim());
		expect(remoteSha.trim()).toBe(secondSha.trim());
	});

	it("fails with WorkspaceCommandError when the remote is unreachable", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(9);
		const wsPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-9"),
		);
		await exec(
			"git",
			["remote", "set-url", "origin", "/nonexistent/path.git"],
			{ cwd: wsPath },
		);
		await exec("git", ["checkout", "-B", "agent/issue-9"], { cwd: wsPath });

		const err = await run(
			pushBranch(wsPath, "agent/issue-9").pipe(Effect.flip),
		);
		expect(err).toBeInstanceOf(WorkspaceCommandError);
		expect((err as WorkspaceCommandError).exitCode).not.toBe(0);
	});
});

describe("removeWorkspace", () => {
	it("deletes the workspace directory", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(4);

		const wsPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-4"),
		);

		await run(removeWorkspace(wsPath));
		await expect(access(wsPath)).rejects.toThrow();
	});
});

describe("sweepWorkspaces", () => {
	it("removes workspace directories older than the TTL and leaves recent ones", async () => {
		await using ws = await createWorkspaceRoot();
		await mkdir(ws.root, { recursive: true });

		const stale = join(ws.root, "stale-run");
		const fresh = join(ws.root, "fresh-run");
		await mkdir(stale);
		await mkdir(fresh);

		const now = Date.now();
		const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000);
		await utimes(stale, eightDaysAgo, eightDaysAgo);

		const result = await run(
			sweepWorkspaces(ws.root, 7 * 24 * 60 * 60 * 1000, now),
		);

		expect(result.removed).toEqual([stale]);
		await expect(access(stale)).rejects.toThrow();
		await expect(access(fresh)).resolves.toBeUndefined();
	});

	it("returns no removals when the workspace root does not yet exist", async () => {
		const path = join(
			tmpdir(),
			`ws-missing-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		const result = await run(sweepWorkspaces(path, 1000));

		expect(result.removed).toEqual([]);
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
	it("executes the setup script in the workspace when present", async () => {
		await using ws = await withWorkspace();
		await writeSetupScript(
			ws.path,
			"#!/usr/bin/env bash\necho ok > setup_output\n",
		);

		const realEnv = { PATH: process.env["PATH"] ?? "" };
		const ran = await run(runRepoSetup(ws.path, realEnv));

		expect(ran).toBe(true);
		await expect(
			access(join(ws.path, "setup_output")),
		).resolves.toBeUndefined();
	});

	it("fails with WorkspaceCommandError when the setup script exits non-zero", async () => {
		await using ws = await withWorkspace();
		await writeSetupScript(ws.path, "#!/usr/bin/env bash\nexit 1\n");

		const realEnv = { PATH: process.env["PATH"] ?? "" };
		const err = await run(runRepoSetup(ws.path, realEnv).pipe(Effect.flip));
		expect(err).toBeInstanceOf(WorkspaceCommandError);
		expect((err as WorkspaceCommandError).exitCode).toBe(1);
	});

	it("is a no-op when the script is absent", async () => {
		await using ws = await withWorkspace();

		const ran = await run(runRepoSetup(ws.path, {}));

		expect(ran).toBe(false);
	});
});

describe("resolveWorkspaceEnvironment", () => {
	it("returns the base env unchanged when the repo has no .nvmrc", async () => {
		await using ws = await withWorkspace();
		const baseEnv = { PATH: "/bin", TOKEN: "secret" };

		const resolved = await run(resolveWorkspaceEnvironment(ws.path, baseEnv));

		expect(resolved).toBe(baseEnv);
	});

	it("activates the .nvmrc version with fnm when available", async () => {
		await using ws = await withWorkspace();
		const fakeToolBin = join(ws.path, "tools", "bin");
		const fakeNodeBin = join(ws.path, "node", "bin");
		await mkdir(fakeToolBin, { recursive: true });
		await mkdir(fakeNodeBin, { recursive: true });
		await writeFile(join(ws.path, ".nvmrc"), "24.10.0\n");
		const fnmPath = join(fakeToolBin, "fnm");
		await writeFile(
			fnmPath,
			[
				"#!/usr/bin/env bash",
				'if [ "$1" = "env" ]; then',
				"  cat <<'FNM_ENV'",
				"fnm() {",
				'  if [ "$1" = "use" ]; then',
				`    export PATH="${fakeNodeBin}:$PATH"`,
				"  fi",
				"}",
				"FNM_ENV",
				"  exit 0",
				"fi",
				"exit 1",
				"",
			].join("\n"),
		);
		await chmod(fnmPath, 0o755);

		const resolved = await run(
			resolveWorkspaceEnvironment(ws.path, {
				PATH: `${fakeToolBin}:${process.env["PATH"] ?? ""}`,
				TOKEN: "secret",
			}),
		);

		expect(resolved["PATH"]?.split(":")[0]).toBe(fakeNodeBin);
		expect(resolved["TOKEN"]).toBe("secret");
	});

	it("fails clearly when .nvmrc is present but fnm is unavailable", async () => {
		await using ws = await withWorkspace();
		await writeFile(join(ws.path, ".nvmrc"), "24.10.0\n");

		const err = await run(
			resolveWorkspaceEnvironment(ws.path, { PATH: "/bin" }).pipe(Effect.flip),
		);
		expect(err).toBeInstanceOf(WorkspaceCommandError);
		expect((err as WorkspaceCommandError).stderr).toMatch(
			/fnm is not available on PATH/,
		);
	});
});

async function makeSkillsSource(skills: Record<string, string>): Promise<{
	path: string;
	[Symbol.asyncDispose](): Promise<void>;
}> {
	const path = join(
		tmpdir(),
		`skills-src-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	await mkdir(path, { recursive: true });
	for (const [name, body] of Object.entries(skills)) {
		await mkdir(join(path, name), { recursive: true });
		await writeFile(join(path, name, "SKILL.md"), body);
	}
	return {
		path,
		async [Symbol.asyncDispose]() {
			await rm(path, { recursive: true, force: true });
		},
	};
}

const TEST_RENDER_VARS = {
	issue: createIssue(42),
	branch: "feat/ABC-42-thing",
	base_branch: "main",
};

describe("installSkills", () => {
	it("copies each skill directory into <ws>/.claude/skills/", async () => {
		await using ws = await withWorkspace();
		await using src = await makeSkillsSource({
			review: "review body",
			implement: "implement body",
		});

		const result = await run(
			installSkills(ws.path, src.path, TEST_RENDER_VARS),
		);

		expect(result.installed.sort()).toEqual(["implement", "review"]);
		expect(result.skipped).toEqual([]);
		await expect(
			readFile(join(ws.path, ".claude/skills/review/SKILL.md"), "utf8"),
		).resolves.toBe("review body");
		await expect(
			readFile(join(ws.path, ".claude/skills/implement/SKILL.md"), "utf8"),
		).resolves.toBe("implement body");
	});

	it("skips skills the target repo already ships under the same name", async () => {
		await using ws = await withWorkspace();
		await mkdir(join(ws.path, ".claude/skills/review"), { recursive: true });
		await writeFile(
			join(ws.path, ".claude/skills/review/SKILL.md"),
			"repo-provided review",
		);
		await using src = await makeSkillsSource({
			review: "LA review",
			implement: "LA implement",
		});

		const result = await run(
			installSkills(ws.path, src.path, TEST_RENDER_VARS),
		);

		expect(result.installed).toEqual(["implement"]);
		expect(result.skipped).toEqual(["review"]);
		await expect(
			readFile(join(ws.path, ".claude/skills/review/SKILL.md"), "utf8"),
		).resolves.toBe("repo-provided review");
	});

	it("returns empty when the skills source directory is missing", async () => {
		await using ws = await withWorkspace();
		const missing = join(
			tmpdir(),
			`missing-skills-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);

		const result = await run(installSkills(ws.path, missing, TEST_RENDER_VARS));

		expect(result).toEqual({ installed: [], skipped: [] });
		await expect(access(join(ws.path, ".claude/skills"))).rejects.toThrow();
	});

	it("ignores non-directory entries in the source", async () => {
		await using ws = await withWorkspace();
		await using src = await makeSkillsSource({ review: "review" });
		await writeFile(join(src.path, "README.md"), "not a skill");

		const result = await run(
			installSkills(ws.path, src.path, TEST_RENDER_VARS),
		);

		expect(result.installed).toEqual(["review"]);
	});

	it("renders {{ }} substitutions in .md files using the supplied vars", async () => {
		await using ws = await withWorkspace();
		await using src = await makeSkillsSource({
			advisor:
				"<commits>\n!`git log origin/{{ base_branch }}..HEAD --oneline`\n</commits>\n\nIssue: {{ issue.key }}, Branch: {{ branch }}.",
		});

		await run(installSkills(ws.path, src.path, TEST_RENDER_VARS));

		const rendered = await readFile(
			join(ws.path, ".claude/skills/advisor/SKILL.md"),
			"utf8",
		);
		expect(rendered).toContain("!`git log origin/main..HEAD --oneline`");
		expect(rendered).toContain(
			`Issue: ${TEST_RENDER_VARS.issue.key}, Branch: feat/ABC-42-thing.`,
		);
	});

	it("renders sibling .md files inside a skill directory, not just SKILL.md", async () => {
		await using ws = await withWorkspace();
		await using src = await makeSkillsSource({
			review: "main on {{ base_branch }}",
		});
		await writeFile(
			join(src.path, "review", "details.md"),
			"detail for {{ branch }}",
		);

		await run(installSkills(ws.path, src.path, TEST_RENDER_VARS));

		await expect(
			readFile(join(ws.path, ".claude/skills/review/SKILL.md"), "utf8"),
		).resolves.toBe("main on main");
		await expect(
			readFile(join(ws.path, ".claude/skills/review/details.md"), "utf8"),
		).resolves.toBe("detail for feat/ABC-42-thing");
	});

	it("adds installed skills to .git/info/exclude so they stay out of git status", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(100);
		const wsPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-skills-exclude"),
		);
		await using src = await makeSkillsSource({
			review: "review body",
			implement: "implement body",
		});

		await run(installSkills(wsPath, src.path, TEST_RENDER_VARS));

		const { stdout: status } = await exec(
			"git",
			["status", "--porcelain", "--ignored"],
			{ cwd: wsPath },
		);
		expect(status).not.toMatch(/\.claude\/skills\/review/);
		expect(status).not.toMatch(/\.claude\/skills\/implement/);

		const exclude = await readFile(join(wsPath, ".git/info/exclude"), "utf8");
		expect(exclude).toMatch(/\.claude\/skills\/review\//);
		expect(exclude).toMatch(/\.claude\/skills\/implement\//);
	});

	it("does not duplicate exclude entries on repeated installs", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(101);
		const wsPath = await run(
			createWorkspace(issue, ws.root, bareRepo, "run-skills-idempotent"),
		);
		await using src = await makeSkillsSource({ review: "review" });

		await run(installSkills(wsPath, src.path, TEST_RENDER_VARS));
		await rm(join(wsPath, ".claude/skills/review"), { recursive: true });
		await run(installSkills(wsPath, src.path, TEST_RENDER_VARS));

		const exclude = await readFile(join(wsPath, ".git/info/exclude"), "utf8");
		const matches = exclude.match(/\.claude\/skills\/review\//g) ?? [];
		expect(matches.length).toBe(1);
	});

	it("leaves non-.md files untouched", async () => {
		await using ws = await withWorkspace();
		await using src = await makeSkillsSource({
			advisor: "see {{ base_branch }}",
		});
		await writeFile(
			join(src.path, "advisor", "fixture.txt"),
			"literal {{ base_branch }} stays",
		);

		await run(installSkills(ws.path, src.path, TEST_RENDER_VARS));

		await expect(
			readFile(join(ws.path, ".claude/skills/advisor/SKILL.md"), "utf8"),
		).resolves.toBe("see main");
		await expect(
			readFile(join(ws.path, ".claude/skills/advisor/fixture.txt"), "utf8"),
		).resolves.toBe("literal {{ base_branch }} stays");
	});
});
