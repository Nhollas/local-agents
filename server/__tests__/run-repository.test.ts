import { describe, expect, it } from "vitest";
import { runStepOutputs, runs } from "../db/schema.ts";
import { createRunRepository } from "../run-repository.ts";
import { createTestDb } from "../testing/support/test-db.ts";
import { issueKey, repoSlug, runId } from "../types/brands.ts";

describe("run repository row projection", () => {
	it("returns failed runs with error and completion fields preserved", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("failed-1"),
				agentName: "agent",
				status: "failed",
				repo: repoSlug("acme/widgets"),
				issueKey: issueKey("acme/widgets#1"),
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
			repo: "acme/widgets",
			issueKey: "acme/widgets#1",
			issueTitle: "boom",
			startedAt: "2025-01-01T00:00:00Z",
			completedAt: "2025-01-01T00:00:02Z",
			durationMs: 2000,
			error: "exploded",
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
});
