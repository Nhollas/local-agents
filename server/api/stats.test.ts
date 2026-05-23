import { describe, expect, it } from "vitest";
import { createTestApi } from "../test-support/test-api.ts";
import { seedRun } from "../test-support/test-db.ts";

const NOW_ISO = "2026-05-09T14:32:08.000Z";
const NOW = new Date(NOW_ISO);
const HOUR_MS = 60 * 60 * 1000;
const fixedClock = () => NOW;

function isoOffset(hoursAgo: number): string {
	return new Date(NOW.getTime() - hoursAgo * HOUR_MS).toISOString();
}

describe("GET /stats", () => {
	it("returns the design-doc shape with asOf set to the server clock", async () => {
		const { app } = createTestApi({ clock: fixedClock, concurrencyMax: 5 });

		const res = await app.request("/stats");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			asOf: NOW_ISO,
			running: { active: 0, max: 5 },
			queued: { count: 0 },
			last24h: {
				completed: 0,
				completedDelta: 0,
				failed: 0,
				successRate: 1,
				spendUsd: 0,
				spendDeltaUsd: 0,
				p50DurationMs: 0,
				p95DurationMs: 0,
				durationSparkline: [],
			},
		});
	});

	it("counts completed/failed runs in the trailing 24h window and computes the prior-window delta", async () => {
		const { app, db } = createTestApi({ clock: fixedClock });
		seedRun(db, {
			id: "c1",
			status: "completed",
			completedAt: isoOffset(2),
			durationMs: 60_000,
			costUsd: 1.0,
		});
		seedRun(db, {
			id: "c2",
			status: "completed",
			completedAt: isoOffset(10),
			durationMs: 120_000,
			costUsd: 2.0,
		});
		seedRun(db, {
			id: "f1",
			status: "failed",
			completedAt: isoOffset(5),
			error: "boom",
			costUsd: 0.5,
		});
		// Prior window (24h–48h ago)
		seedRun(db, {
			id: "p1",
			status: "completed",
			completedAt: isoOffset(30),
			durationMs: 30_000,
			costUsd: 0.4,
		});
		// Outside both windows (>48h ago) — ignored
		seedRun(db, {
			id: "old",
			status: "completed",
			completedAt: isoOffset(72),
			durationMs: 90_000,
			costUsd: 9.0,
		});

		const body = (await (await app.request("/stats")).json()) as {
			last24h: {
				completed: number;
				completedDelta: number;
				failed: number;
				successRate: number;
				spendUsd: number;
				spendDeltaUsd: number;
			};
		};

		expect(body.last24h.completed).toBe(2);
		expect(body.last24h.completedDelta).toBe(1);
		expect(body.last24h.failed).toBe(1);
		expect(body.last24h.successRate).toBeCloseTo(2 / 3, 10);
		expect(body.last24h.spendUsd).toBeCloseTo(3.5, 10);
		expect(body.last24h.spendDeltaUsd).toBeCloseTo(3.1, 10);
	});

	it("returns successRate=1 when there are zero failures", async () => {
		const { app, db } = createTestApi({ clock: fixedClock });
		seedRun(db, {
			id: "c1",
			status: "completed",
			completedAt: isoOffset(2),
			durationMs: 60_000,
			costUsd: 0,
		});

		const body = (await (await app.request("/stats")).json()) as {
			last24h: { successRate: number };
		};
		expect(body.last24h.successRate).toBe(1);
	});

	it("computes p50 and p95 from completed-run durations in the window", async () => {
		const { app, db } = createTestApi({ clock: fixedClock });
		const durations = [
			100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000,
			900_000, 1_000_000,
		];
		durations.forEach((ms, i) => {
			seedRun(db, {
				id: `c${i}`,
				status: "completed",
				completedAt: isoOffset(1 + i * 0.1),
				durationMs: ms,
				costUsd: 0,
			});
		});

		const body = (await (await app.request("/stats")).json()) as {
			last24h: { p50DurationMs: number; p95DurationMs: number };
		};
		// linear interpolation across [100000..1000000], n=10
		// p50 rank = 4.5 → 550000
		// p95 rank = 8.55 → 955000
		expect(body.last24h.p50DurationMs).toBe(550_000);
		expect(body.last24h.p95DurationMs).toBe(955_000);
	});

	it("returns the last 10 completed-run durations in the window oldest → newest", async () => {
		const { app, db } = createTestApi({ clock: fixedClock });
		// Seed 12 completions in the window, oldest first
		for (let i = 0; i < 12; i++) {
			seedRun(db, {
				id: `c${i}`,
				status: "completed",
				completedAt: isoOffset(20 - i * 0.5),
				durationMs: (i + 1) * 1000,
				costUsd: 0,
			});
		}

		const body = (await (await app.request("/stats")).json()) as {
			last24h: { durationSparkline: number[] };
		};
		// Last 10, oldest → newest, are c2..c11 → durations 3000..12000
		expect(body.last24h.durationSparkline).toEqual([
			3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000,
		]);
	});

	it("reports running.active from in-flight runs and queued.count from the orchestrator queue", async () => {
		const { app } = createTestApi({
			clock: fixedClock,
			concurrencyMax: 5,
			queued: [
				{
					issueKey: "ACME-1",
					issueTitle: "queued",
					repo: "acme/api",
					pendingSince: isoOffset(0.1),
				},
				{
					issueKey: "ACME-2",
					issueTitle: "queued",
					repo: "acme/api",
					pendingSince: isoOffset(0.05),
				},
			],
		});

		const body = (await (await app.request("/stats")).json()) as {
			running: { active: number; max: number };
			queued: { count: number };
		};
		expect(body.running).toEqual({ active: 0, max: 5 });
		expect(body.queued).toEqual({ count: 2 });
	});

	it("reports running.active including in-flight runs from the repository", async () => {
		const { app, db } = createTestApi({ clock: fixedClock, concurrencyMax: 3 });
		seedRun(db, { id: "r1", status: "running", startedAt: isoOffset(0.1) });
		seedRun(db, { id: "r2", status: "running", startedAt: isoOffset(0.05) });

		const body = (await (await app.request("/stats")).json()) as {
			running: { active: number; max: number };
		};
		expect(body.running).toEqual({ active: 2, max: 3 });
	});
});
