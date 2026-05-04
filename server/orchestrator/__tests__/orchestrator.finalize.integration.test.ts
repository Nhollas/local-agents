import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import {
	createScopedJiraIssue,
	GITLAB_API,
	JIRA_API,
	jiraIssueKey,
	noopAgent,
	STATUSES,
	TRIGGER_LABEL,
} from "../../testing/support/fixtures.ts";
import {
	jiraHandlers,
	server,
	TRANSITIONS,
} from "../../testing/support/msw.ts";
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
		const transitionedTo: string[] = [];
		const labelUpdates: Array<Array<{ add: string } | { remove: string }>> = [];
		server.use(
			http.post(`${JIRA_API}/issue/:key/transitions`, async ({ request }) => {
				const body = (await request.json()) as {
					transition: { id: string };
				};
				const target = TRANSITIONS.find((t) => t.id === body.transition.id);
				transitionedTo.push(target?.to.name ?? `unknown:${body.transition.id}`);
				return new HttpResponse(null, { status: 204 });
			}),
			http.put(`${JIRA_API}/issue/:key`, async ({ request }) => {
				const body = (await request.json()) as {
					update?: {
						labels?: Array<{ add: string } | { remove: string }>;
					};
				};
				labelUpdates.push(body.update?.labels ?? []);
				return new HttpResponse(null, { status: 204 });
			}),
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
		expect(transitionedTo).toEqual([STATUSES.running]);
		expect(labelUpdates).toEqual([
			[{ add: `${TRIGGER_LABEL}-failed` }, { remove: TRIGGER_LABEL }],
		]);
	});
});
