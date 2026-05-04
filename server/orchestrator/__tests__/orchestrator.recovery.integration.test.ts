import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import type { Db } from "../../db/db.ts";
import { runs } from "../../db/schema.ts";
import {
	createScopedJiraIssue,
	JIRA_API,
	jiraIssueKey,
	REPO,
	STATUSES,
} from "../../testing/support/fixtures.ts";
import { jiraHandlers, server } from "../../testing/support/msw.ts";
import { seedRun } from "../../testing/support/test-db.ts";
import { createTestOrchestrator } from "../../testing/support/test-orchestrator.ts";

function seedStaleRun(db: Db) {
	seedRun(db, {
		id: "stale-run",
		agentName: "issue-5",
		status: "running",
		issueKey: jiraIssueKey(5),
		issueTitle: "Stale issue",
		startedAt: "2025-01-01T00:00:00Z",
	});
}

describe("Orchestrator startup recovery", () => {
	it("fails DB runs left in 'running' from a previous process", async () => {
		server.use(...jiraHandlers({ resolveIssues: () => [] }));

		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, db } = ctx;

		seedStaleRun(db);

		await orchestrator.recover();

		expect(db.select().from(runs).all()).toEqual([
			{
				id: "stale-run",
				agentName: "issue-5",
				status: "failed",
				error: "Stale run from previous session",
				repo: REPO,
				issueKey: jiraIssueKey(5),
				issueTitle: "Stale issue",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: expect.any(String),
				durationMs: null,
			},
		]);
	});

	it("transitions tracker issues stuck in 'running' back to 'pending'", async () => {
		const transitionCalls: { issueKey: string; transitionId: string }[] = [];

		server.use(
			http.post(
				`${JIRA_API}/issue/:key/transitions`,
				async ({ params, request }) => {
					const body = (await request.json()) as {
						transition: { id: string };
					};
					transitionCalls.push({
						issueKey: String(params["key"]),
						transitionId: body.transition.id,
					});
					return new HttpResponse(null, { status: 204 });
				},
			),
			...jiraHandlers({
				resolveIssues: (status) =>
					status === "running"
						? [createScopedJiraIssue(7, STATUSES.running)]
						: [],
			}),
		);

		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator } = ctx;

		await orchestrator.recover();

		expect(transitionCalls).toEqual([
			{ issueKey: jiraIssueKey(7), transitionId: "31" },
		]);
	});

	it("still cleans up stale DB runs when tracker fetch fails", async () => {
		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				if (body.jql?.includes(`status = "${STATUSES.running}"`)) {
					return new HttpResponse(null, { status: 500 });
				}
				return HttpResponse.json({ issues: [] });
			}),
		);

		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator, db } = ctx;

		seedStaleRun(db);

		await orchestrator.recover();

		const all = db.select().from(runs).all();
		expect(all[0]?.status).toBe("failed");
	});

	it("does not fetch tracker 'running' issues during a tick", async () => {
		let runningFetches = 0;
		let pendingFetches = 0;

		server.use(
			http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
				const body = (await request.json()) as { jql?: string };
				const jql = body.jql ?? "";
				if (jql.includes(`status = "${STATUSES.running}"`)) {
					runningFetches++;
				} else if (jql.includes(`status = "${STATUSES.pending}"`)) {
					pendingFetches++;
				}
				return HttpResponse.json({ issues: [] });
			}),
		);

		await using ctx = await createTestOrchestrator({ maxConcurrency: 5 });
		const { orchestrator } = ctx;

		await orchestrator.tick();

		expect(pendingFetches).toBe(1);
		expect(runningFetches).toBe(0);
	});
});
