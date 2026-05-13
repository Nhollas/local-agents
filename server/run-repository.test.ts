import { describe, expect, it } from "vitest";
import { runStepOutputs, runs } from "./db/schema.ts";
import { createRunRepository } from "./run-repository.ts";
import { createTestDb } from "./test-support/test-db.ts";
import { issueKey, repoSlug, runId } from "./types/brands.ts";

describe("run repository row projection", () => {
	it("returns failed runs with error and completion fields preserved", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("failed-1"),
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
			status: "failed",
			repo: "acme/widgets",
			repoUrl: null,
			branch: null,
			workspaceDir: null,
			issueKey: "acme/widgets#1",
			issueTitle: "boom",
			issueUrl: null,
			startedAt: "2025-01-01T00:00:00Z",
			completedAt: "2025-01-01T00:00:02Z",
			durationMs: 2000,
			error: "exploded",
			costUsd: null,
			tokensInput: null,
			tokensOutput: null,
			pr: null,
			failedStep: null,
			finalizeFailure: null,
			langfuseTraceUrl: null,
		});
	});

	it("populates failedStep from the runSteps row marked failed", () => {
		const db = createTestDb();
		const repo = createRunRepository(db);
		db.insert(runs)
			.values({
				id: runId("failed-2"),
				status: "failed",
				repo: repoSlug("acme/widgets"),
				issueKey: issueKey("acme/widgets#2"),
				issueTitle: "boom",
				startedAt: "2025-01-01T00:00:00Z",
				completedAt: "2025-01-01T00:00:02Z",
				durationMs: 2000,
				error: "no commits made",
			})
			.run();
		repo.insertSteps(runId("failed-2"), [
			{ index: 1, name: "implement" },
			{ index: 2, name: "review" },
		]);
		repo.failStep(runId("failed-2"), 1, {
			completedAt: "2025-01-01T00:00:02Z",
			durationMs: 2000,
			error: "no commits made",
		});

		const run = repo.getRunById(runId("failed-2"));
		expect(run?.status).toBe("failed");
		if (run?.status !== "failed") throw new Error("expected failed run");
		expect(run.failedStep).toEqual({ index: 1, name: "implement" });

		const list = repo.getRuns({ limit: 10 });
		const fromList = list.find((r) => r.id === "failed-2");
		expect(fromList?.status).toBe("failed");
		if (fromList?.status !== "failed") throw new Error("expected failed run");
		expect(fromList.failedStep).toEqual({ index: 1, name: "implement" });
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
