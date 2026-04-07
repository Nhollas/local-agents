import { execFile } from "node:child_process";
import { access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Issue } from "../trackers/types.ts";
import { ensureWorkspace, removeWorkspace } from "./workspace.ts";

const exec = promisify(execFile);

function createIssue(number: number): Issue {
	return {
		key: `test-owner/test-repo#${number}`,
		number,
		title: `Issue ${number}`,
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
	await exec("git", ["init", "--bare", bareRepo]);
});

afterAll(async () => {
	await rm(bareRepo, { recursive: true, force: true });
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

describe("ensureWorkspace", () => {
	it("returns created: false when workspace already exists", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(1);

		const first = await ensureWorkspace(issue, ws.root, bareRepo);
		expect(first.created).toBe(true);

		const second = await ensureWorkspace(issue, ws.root, bareRepo);
		expect(second.created).toBe(false);
		expect(second.path).toBe(first.path);
	});

	it("runs after_create hook in newly cloned workspace", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(2);

		const result = await ensureWorkspace(issue, ws.root, bareRepo, {
			after_create: "touch hook_ran",
		});

		expect(result.created).toBe(true);
		await expect(
			access(join(result.path, "hook_ran")),
		).resolves.toBeUndefined();
	});

	it("does not run after_create hook when workspace already exists", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(3);

		await ensureWorkspace(issue, ws.root, bareRepo);

		const result = await ensureWorkspace(issue, ws.root, bareRepo, {
			after_create: "touch should_not_exist",
		});

		expect(result.created).toBe(false);
		await expect(
			access(join(result.path, "should_not_exist")),
		).rejects.toThrow();
	});
});

describe("removeWorkspace", () => {
	it("deletes the workspace directory", async () => {
		await using ws = await createWorkspaceRoot();
		const issue = createIssue(4);

		const { path: wsPath } = await ensureWorkspace(issue, ws.root, bareRepo);

		await removeWorkspace(wsPath);
		await expect(access(wsPath)).rejects.toThrow();
	});
});
