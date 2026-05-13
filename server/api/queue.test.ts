import { describe, expect, it } from "vitest";
import { createTestApi } from "../test-support/test-api.ts";
import { seedRun, seedStep } from "../test-support/test-db.ts";
import { issueKey, repoSlug } from "../types/brands.ts";

describe("GET /queue", () => {
	it("returns empty active and queued lists when nothing is running or queued", async () => {
		const { app } = createTestApi();

		const res = await app.request("/queue");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ active: [], queued: [] });
	});

	it("returns running runs as ActiveRun with currentStep + progressRatio", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "run_9f3b2e1c",
			status: "running",
			repo: "acme/api",
			issueKey: "ACME-1284",
			issueTitle: "npm install hangs on linux runners",
			issueUrl: null,
			branch: "fix/ACME-1284-npm-install-hang",
			workspaceDir: "/tmp/lag/9f3b2e1",
			costUsd: 0.034,
			tokensInput: 9800,
			tokensOutput: 2600,
			startedAt: "2026-05-09T14:27:56Z",
		});
		seedStep(db, {
			runId: "run_9f3b2e1c",
			index: 1,
			name: "implement",
			state: "running",
			startedAt: "2026-05-09T14:28:19Z",
		});
		seedStep(db, {
			runId: "run_9f3b2e1c",
			index: 2,
			name: "review",
			state: "pending",
		});
		seedStep(db, {
			runId: "run_9f3b2e1c",
			index: 3,
			name: "summarise",
			state: "pending",
		});

		const res = await app.request("/queue");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			active: [
				{
					id: "run_9f3b2e1c",
					status: "running",
					error: null,
					repo: "acme/api",
					repoUrl: null,
					branch: "fix/ACME-1284-npm-install-hang",
					workspaceDir: "/tmp/lag/9f3b2e1",
					issueKey: "ACME-1284",
					issueTitle: "npm install hangs on linux runners",
					issueUrl: null,
					startedAt: "2026-05-09T14:27:56Z",
					completedAt: null,
					durationMs: null,
					costUsd: 0.034,
					tokensInput: 9800,
					tokensOutput: 2600,
					pr: null,
					failedStep: null,
					finalizeFailure: null,
					langfuseTraceUrl: null,
					currentStep: { name: "implement", index: 1, total: 3 },
					progressRatio: 0.5 / 3,
				},
			],
			queued: [],
		});
	});

	it("computes progressRatio as (completed + 0.5 if any running) / total", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "r1",
			status: "running",
			startedAt: "2026-01-01T00:00:00Z",
		});
		seedStep(db, { runId: "r1", index: 1, name: "a", state: "completed" });
		seedStep(db, { runId: "r1", index: 2, name: "b", state: "running" });
		seedStep(db, { runId: "r1", index: 3, name: "c", state: "pending" });

		const body = (await (await app.request("/queue")).json()) as {
			active: Array<{ progressRatio: number }>;
		};
		expect(body.active[0]?.progressRatio).toBeCloseTo(1.5 / 3, 10);
	});

	it("reports currentStep null when between steps", async () => {
		const { app, db } = createTestApi();
		seedRun(db, {
			id: "r2",
			status: "running",
			startedAt: "2026-01-01T00:00:00Z",
		});
		seedStep(db, { runId: "r2", index: 1, name: "a", state: "completed" });
		seedStep(db, { runId: "r2", index: 2, name: "b", state: "pending" });

		const body = (await (await app.request("/queue")).json()) as {
			active: Array<{ currentStep: unknown; progressRatio: number }>;
		};
		expect(body.active[0]?.currentStep).toBeNull();
		expect(body.active[0]?.progressRatio).toBe(1 / 2);
	});

	it("returns queued items from the orchestrator's holding queue", async () => {
		const { app } = createTestApi({
			queued: [
				{
					issueKey: issueKey("ACME-1285"),
					issueTitle: "500 on /api/runs?limit=0",
					repo: repoSlug("acme/api"),
					pendingSince: "2026-05-09T14:31:42Z",
				},
				{
					issueKey: issueKey("WIDGETS-911"),
					issueTitle: "cover branch-resolver edges",
					repo: repoSlug("widgets/dashboard"),
					pendingSince: "2026-05-09T14:31:55Z",
				},
			],
		});

		const res = await app.request("/queue");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			active: [],
			queued: [
				{
					issueKey: "ACME-1285",
					issueTitle: "500 on /api/runs?limit=0",
					repo: "acme/api",
					pendingSince: "2026-05-09T14:31:42Z",
				},
				{
					issueKey: "WIDGETS-911",
					issueTitle: "cover branch-resolver edges",
					repo: "widgets/dashboard",
					pendingSince: "2026-05-09T14:31:55Z",
				},
			],
		});
	});
});
