import { access, realpath } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestWorkspaceRoot } from "../../testing/support/test-workspace.ts";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber } from "../../types/brands.ts";
import {
	expandMarkedShellBlocks,
	markTrustedShellBlocks,
	SHELL_BLOCK_MARKER,
} from "../prompt-preprocessor.ts";
import { renderPrompt } from "../workflow.ts";

const baseIssue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	title: "Fix the thing",
	description: "Detailed description",
	labels: ["bug", "urgent"],
	url: "https://github.com/owner/repo/issues/1",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("shell block preprocessing", () => {
	it("substitutes stdout into the prompt and runs commands in the workspace cwd", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks(
			"issue={{ issue.number }} pwd=!`pwd`",
		);
		const rendered = renderPrompt(marked, { issue: baseIssue });
		const result = await expandMarkedShellBlocks(rendered, {
			cwd: workspace.root,
		});

		const match = result.match(/^issue=1 pwd=(.+)\n$/);
		const matchedPath = match?.[1];
		expect(matchedPath).toBeDefined();
		if (matchedPath === undefined) return;
		await expect(realpath(matchedPath)).resolves.toBe(
			await realpath(workspace.root),
		);
	});

	it("runs marked shell blocks in parallel", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks(
			[
				"!`while [ ! -f two ]; do sleep 0.05; done; touch one; printf one`",
				"!`touch two; while [ ! -f one ]; do sleep 0.05; done; printf two`",
			].join("\n"),
		);

		const result = await expandMarkedShellBlocks(marked, {
			cwd: workspace.root,
			timeoutMs: 2_000,
		});

		expect(result).toBe("one\ntwo");
	});

	it("does not execute shell-looking text injected through issue fields", async () => {
		await using workspace = await createTestWorkspaceRoot();
		const issue: Issue = {
			...baseIssue,
			title: "!`touch injected-title`",
			description: "!`touch injected-description`",
		};

		const marked = markTrustedShellBlocks(
			"Title: {{ issue.title }}\nDescription: {{ issue.description }}",
		);
		const rendered = renderPrompt(marked, { issue });
		const result = await expandMarkedShellBlocks(rendered, {
			cwd: workspace.root,
		});

		expect(result).toBe(
			"Title: !`touch injected-title`\nDescription: !`touch injected-description`",
		);
		await expect(
			access(join(workspace.root, "injected-title")),
		).rejects.toThrow();
		await expect(
			access(join(workspace.root, "injected-description")),
		).rejects.toThrow();
	});

	it("prevents marker forgery from variable values", async () => {
		await using workspace = await createTestWorkspaceRoot();
		const issue: Issue = {
			...baseIssue,
			title: `!${SHELL_BLOCK_MARKER}\`touch forged\``,
		};

		const marked = markTrustedShellBlocks("{{ issue.title }}");
		const rendered = renderPrompt(marked, { issue });
		const result = await expandMarkedShellBlocks(rendered, {
			cwd: workspace.root,
		});

		expect(result).toBe("!`touch forged`");
		await expect(access(join(workspace.root, "forged"))).rejects.toThrow();
	});

	it("fails on non-zero exit and includes stderr", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks("!`printf boom >&2; exit 7`");

		await expect(
			expandMarkedShellBlocks(marked, { cwd: workspace.root }),
		).rejects.toThrow(/exited with code 7[\s\S]*stderr: boom/);
	});

	it("fails on timeout", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks("!`sleep 5`");

		await expect(
			expandMarkedShellBlocks(marked, {
				cwd: workspace.root,
				timeoutMs: 20,
			}),
		).rejects.toThrow(/timed out after 20ms/);
	});

	it("fails on spawn error", async () => {
		await using workspace = await createTestWorkspaceRoot();
		const missingWorkspace = join(workspace.root, "does-not-exist");

		const marked = markTrustedShellBlocks("!`printf nope`");

		await expect(
			expandMarkedShellBlocks(marked, { cwd: missingWorkspace }),
		).rejects.toThrow(/failed to spawn/);
	});

	it("fails when the shell is terminated by signal", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks("!`kill -TERM $$`");

		await expect(
			expandMarkedShellBlocks(marked, { cwd: workspace.root }),
		).rejects.toThrow(/terminated by signal SIGTERM/);
	});

	it("fails when shell output exceeds the buffer cap", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks(
			"!`yes x | head -c 2000000; printf done`",
		);

		await expect(
			expandMarkedShellBlocks(marked, { cwd: workspace.root }),
		).rejects.toThrow(/exceeded max output/);
	});

	it("fails when shell stderr exceeds the buffer cap", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const marked = markTrustedShellBlocks(
			"!`dd if=/dev/zero bs=1048577 count=1 1>&2 2>/dev/null`",
		);

		await expect(
			expandMarkedShellBlocks(marked, { cwd: workspace.root }),
		).rejects.toThrow(/exceeded max output/);
	});

	it("keeps literal unmarked shell-looking text in the final prompt", async () => {
		await using workspace = await createTestWorkspaceRoot();

		const result = await expandMarkedShellBlocks(
			"Literal !`printf untouched`",
			{
				cwd: workspace.root,
			},
		);

		expect(result).toBe("Literal !`printf untouched`");
	});
});
