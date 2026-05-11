import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitizeKey } from "../orchestrator/workspace.ts";
import type { RepoSlug } from "../types/brands.ts";

const exec = promisify(execFile);

export async function seedBareRepoMain(barePath: string): Promise<void> {
	await exec("git", ["init", "--bare", "--initial-branch=main", barePath]);
	const seedDir = `${barePath}.seed`;
	await exec("git", ["clone", barePath, seedDir]);
	await exec("git", ["config", "user.email", "test@example.test"], {
		cwd: seedDir,
	});
	await exec("git", ["config", "user.name", "Test"], { cwd: seedDir });
	await exec("git", ["commit", "--allow-empty", "-m", "seed"], {
		cwd: seedDir,
	});
	await exec("git", ["push", "origin", "main"], { cwd: seedDir });
	await rm(seedDir, { recursive: true, force: true });
}

type TestWorkspace = {
	root: string;
	/** Seed a bare remote for `repo` and return its on-disk path (the clone URL). */
	setupRepoRemote(repo: RepoSlug): Promise<string>;
	bareRemotePath(repo: RepoSlug): string;
	[Symbol.asyncDispose](): Promise<void>;
};

export async function createTestWorkspaceRoot(): Promise<TestWorkspace> {
	const root = join(
		tmpdir(),
		`local-agents-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
	);
	const remotesRoot = join(root, "__remotes__");
	await mkdir(remotesRoot, { recursive: true });

	function bareRemotePath(repo: RepoSlug): string {
		return join(remotesRoot, `${sanitizeKey(repo)}.git`);
	}

	const seeded = new Set<RepoSlug>();

	return {
		root,
		bareRemotePath,
		async setupRepoRemote(repo: RepoSlug): Promise<string> {
			const bare = bareRemotePath(repo);
			if (!seeded.has(repo)) {
				await seedBareRepoMain(bare);
				seeded.add(repo);
			}
			return bare;
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
