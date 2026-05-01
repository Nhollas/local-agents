import { describe, expect, it } from "vitest";
import { runStepOutputs, runs } from "../db/schema.ts";
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
			stepIndex: 0,
		});
	});
});

describe("step outputs", () => {
	it("writeStepOutput persists a row keyed by (runId, stepName)", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		repo.writeStepOutput(runId("r1"), "summarise", {
			title: "Hello",
			tags: ["a", "b"],
		});

		const rows = db.select().from(runStepOutputs).all();
		expect(rows).toEqual([
			{
				runId: "r1",
				stepName: "summarise",
				outputJson: { title: "Hello", tags: ["a", "b"] },
				createdAt: expect.any(String),
			},
		]);
	});

	it("writeStepOutput overwrites an existing row for the same (runId, stepName)", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		repo.writeStepOutput(runId("r1"), "summarise", { v: 1 });
		repo.writeStepOutput(runId("r1"), "summarise", { v: 2 });

		const rows = db.select().from(runStepOutputs).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.outputJson).toEqual({ v: 2 });
	});

	it("getStepOutputs returns the full map keyed by stepName for a run", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		repo.writeStepOutput(runId("r1"), "summarise", { title: "T" });
		repo.writeStepOutput(runId("r1"), "tag", { tags: ["x"] });
		repo.writeStepOutput(runId("r2"), "other", { ignored: true });

		expect(repo.getStepOutputs(runId("r1"))).toEqual({
			summarise: { title: "T" },
			tag: { tags: ["x"] },
		});
	});

	it("getStepOutputs returns an empty map when there are no rows for the run", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		expect(repo.getStepOutputs(runId("missing"))).toEqual({});
	});
});
