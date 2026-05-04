import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
	createScopedJiraIssue,
	GITLAB_API,
	jiraIssueKey,
	noopAgent,
} from "../../testing/support/fixtures.ts";
import { jiraHandlers, server } from "../../testing/support/msw.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

const exec = promisify(execFile);

async function listRemoteBranches(barePath: string): Promise<string[]> {
	const { stdout } = await exec("git", ["branch", "--list"], { cwd: barePath });
	return stdout
		.split("\n")
		.map((line) => line.replace(/^[*+ ]+/, "").trim())
		.filter(Boolean);
}

describe("Orchestrator success-path finalization", () => {
	it("pushes the agent's branch to the remote before opening the change request", async () => {
		server.use(...jiraHandlers({ issues: [createScopedJiraIssue(11)] }));

		let mrCreateCalled = false;
		await using ctx = await createTestOrchestrator({
			runAgent: noopAgent,
			codeHost: (defaults) => ({
				...defaults,
				createChangeRequest: async () => {
					mrCreateCalled = true;
					return { number: 1, url: "https://example.test/mr/1" };
				},
			}),
		});
		const { orchestrator, runner, workspace } = ctx;
		const issueKey = jiraIssueKey(11);
		const wsPath = await workspace.preCreateWorkspace(issueKey);

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		const remoteBranches = await listRemoteBranches(
			workspace.bareRemotePath(issueKey),
		);
		expect(remoteBranches).toContain("agent/issue-11");
		expect(mrCreateCalled).toBe(true);
		await expect(access(wsPath)).rejects.toThrow();
	});

	it("skips MR creation and tracker transition when the push fails, and marks the issue failed", async () => {
		server.use(...jiraHandlers({ issues: [createScopedJiraIssue(12)] }));

		let mrCreateCalled = false;
		const transitionCalls: string[] = [];
		const labelUpdates: { add?: string[]; remove?: string[] }[] = [];
		server.use(
			http.post(
				`https://jira.example.test/rest/api/3/issue/:key/transitions`,
				async ({ request }) => {
					const body = (await request.json()) as {
						transition: { id: string };
					};
					transitionCalls.push(body.transition.id);
					return new HttpResponse(null, { status: 204 });
				},
			),
			http.put(
				`https://jira.example.test/rest/api/3/issue/:key`,
				async ({ request }) => {
					const body = (await request.json()) as {
						update?: {
							labels?: { add?: string; remove?: string }[];
						};
					};
					const ops = body.update?.labels ?? [];
					const add = ops.flatMap((op) => (op.add ? [op.add] : []));
					const remove = ops.flatMap((op) => (op.remove ? [op.remove] : []));
					labelUpdates.push({ add, remove });
					return new HttpResponse(null, { status: 204 });
				},
			),
			http.post(`${GITLAB_API}/projects/:project/merge_requests`, () => {
				mrCreateCalled = true;
				return HttpResponse.json({ iid: 1, web_url: "" });
			}),
		);

		await using ctx = await createTestOrchestrator({ runAgent: noopAgent });
		const { orchestrator, runner, workspace } = ctx;
		const issueKey = jiraIssueKey(12);
		const wsPath = await workspace.preCreateWorkspace(issueKey, {
			brokenRemote: true,
		});

		await orchestrator.tick();
		await runner.queue.waitForIdle();
		await orchestrator.settled();

		expect(mrCreateCalled).toBe(false);
		await expect(access(wsPath)).resolves.toBeUndefined();
		// Only the dispatch transition (id="11") should have fired; the
		// awaiting_review transition (id="21") must NOT.
		expect(transitionCalls).toEqual(["11"]);
		// markFailed adds the failed label.
		const sawFailedLabelAdded = labelUpdates.some((u) =>
			u.add?.includes("agent-failed"),
		);
		expect(sawFailedLabelAdded).toBe(true);
	});
});
