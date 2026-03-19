import { describe, expect, it, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "./migrate.ts";
import { runs, runEvents } from "./schema.ts";

const sqlite = new Database(":memory:");
sqlite.pragma("journal_mode = WAL");
const testDb = drizzle(sqlite);

vi.mock("./db.ts", () => ({
  getDb: () => testDb,
}));

vi.mock("./logger.ts", () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return { logger: log };
});

const { createGateway } = await import("./gateway.ts");

function seedRuns() {
  testDb
    .insert(runs)
    .values([
      {
        id: "run-1",
        agentName: "pr-summary",
        status: "completed",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: "2026-01-01T00:01:00Z",
        durationMs: 60000,
      },
      {
        id: "run-2",
        agentName: "pr-summary",
        status: "failed",
        error: "timeout",
        startedAt: "2026-01-01T01:00:00Z",
        completedAt: "2026-01-01T01:00:30Z",
        durationMs: 30000,
      },
      {
        id: "run-3",
        agentName: "pr-conventions-check",
        status: "completed",
        startedAt: "2026-01-01T02:00:00Z",
        completedAt: "2026-01-01T02:05:00Z",
        durationMs: 300000,
      },
    ])
    .run();

  testDb
    .insert(runEvents)
    .values([
      {
        id: "ev-1",
        runId: "run-1",
        type: "run:started",
        data: { repo: "owner/repo" },
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "ev-2",
        runId: "run-1",
        type: "run:completed",
        data: { durationMs: 60000 },
        createdAt: "2026-01-01T00:01:00Z",
      },
    ])
    .run();
}

describe("runs API", () => {
  let app: ReturnType<typeof createGateway>["app"];

  beforeEach(() => {
    migrate(testDb);
    testDb.delete(runEvents).run();
    testDb.delete(runs).run();
    seedRuns();
    ({ app } = createGateway({
      secret: "test-secret",
      model: "test-model",
      agents: [],
    }));
  });

  describe("GET /runs", () => {
    it("returns all runs ordered by started_at desc", async () => {
      const res = await app.request("/runs");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toHaveLength(3);
      expect(data[0].id).toBe("run-3");
      expect(data[1].id).toBe("run-2");
      expect(data[2].id).toBe("run-1");
    });

    it("filters by agent name", async () => {
      const res = await app.request("/runs?agent=pr-summary");
      const data = await res.json();
      expect(data).toHaveLength(2);
      expect(data.every((r: any) => r.agentName === "pr-summary")).toBe(true);
    });

    it("filters by status", async () => {
      const res = await app.request("/runs?status=failed");
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("run-2");
      expect(data[0].error).toBe("timeout");
    });

    it("combines agent and status filters", async () => {
      const res = await app.request("/runs?agent=pr-summary&status=completed");
      const data = await res.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe("run-1");
    });
  });

  describe("GET /runs/:id", () => {
    it("returns a run with its events", async () => {
      const res = await app.request("/runs/run-1");
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("run-1");
      expect(data.agentName).toBe("pr-summary");
      expect(data.events).toHaveLength(2);
      expect(data.events[0].type).toBe("run:started");
      expect(data.events[1].type).toBe("run:completed");
    });

    it("returns 404 for unknown run id", async () => {
      const res = await app.request("/runs/nonexistent");
      expect(res.status).toBe(404);
    });
  });
});
