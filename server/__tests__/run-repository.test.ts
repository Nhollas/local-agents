import { describe, expect, it } from "vitest";
import { runs } from "../db/schema.ts";
import { createRunRepository } from "../run-repository.ts";
import { createTestDb } from "../testing/support/test-db.ts";
import { issueKey, runId } from "../types/brands.ts";

describe("run repository row projection", () => {
	it("throws when a completed row is missing completedAt", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("bad-completed"),
				agentName: "agent",
				status: "completed",
				startedAt: "2025-01-01T00:00:00Z",
				durationMs: 100,
			})
			.run();

		expect(() => repo.getRunById(runId("bad-completed"))).toThrow(
			/Invariant: completed run/,
		);
	});

	it("throws when a failed row is missing error", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("bad-failed"),
				agentName: "agent",
				status: "failed",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: "2025-01-01T00:00:01Z",
			})
			.run();

		expect(() => repo.getRunById(runId("bad-failed"))).toThrow(
			/Invariant: failed run/,
		);
	});

	it("returns failed runs with error and completion fields preserved", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("failed-1"),
				agentName: "agent",
				status: "failed",
				issueKey: issueKey("owner/repo#1"),
				issueTitle: "boom",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: "2025-01-01T00:00:02Z",
				durationMs: 2000,
				error: "exploded",
			})
			.run();

		const run = repo.getRunById(runId("failed-1"));
		expect(run).toEqual({
			id: "failed-1",
			agentName: "agent",
			status: "failed",
			issueKey: "owner/repo#1",
			issueTitle: "boom",
			startedAt: "2025-01-01T00:00:00Z",
			completedAt: "2025-01-01T00:00:02Z",
			durationMs: 2000,
			error: "exploded",
			sessionId: null,
			attempt: 1,
			parentRunId: null,
			phaseIndex: 0,
		});
	});
});
