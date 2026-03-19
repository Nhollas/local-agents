import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import { migrate } from "./migrate.ts";
import { runs, runEvents } from "./schema.ts";
import { eventBus, type RunEvent } from "./event-bus.ts";
import type { AgentDefinition, AgentContext } from "./types.ts";

// We need to mock getDb to use an in-memory database
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

// Import after mocks are set up
const { createRunner } = await import("./runner.ts");

function createTestContext(): AgentContext {
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn(), child: vi.fn() } as any;
  return {
    event: "pull_request",
    action: "opened",
    payload: {},
    logger: log,
    model: "test-model",
    repo: "owner/repo",
    prNumber: 1,
    headBranch: "feature",
    diff: vi.fn(async () => ""),
    clone: vi.fn(async () => {}),
    comment: vi.fn(async () => 1),
  };
}

function createAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name: "test-agent",
    triggers: [{ event: "pull_request", action: "opened" }],
    handler: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("runner", () => {
  beforeEach(() => {
    migrate(testDb);
    // Clean tables between tests
    testDb.delete(runEvents).run();
    testDb.delete(runs).run();
  });

  it("persists a successful run to the database", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    const agent = createAgent();
    const ctx = createTestContext();

    runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const allRuns = testDb.select().from(runs).all();
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0].agentName).toBe("test-agent");
    expect(allRuns[0].status).toBe("completed");
    expect(allRuns[0].durationMs).toBeTypeOf("number");
  });

  it("persists a failed run with error details", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    const agent = createAgent({
      handler: vi.fn(async () => {
        throw new Error("agent crashed");
      }),
    });
    const ctx = createTestContext();

    runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const allRuns = testDb.select().from(runs).all();
    expect(allRuns).toHaveLength(1);
    expect(allRuns[0].status).toBe("failed");
    expect(allRuns[0].error).toBe("agent crashed");
  });

  it("emits run:started and run:completed events", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    const agent = createAgent();
    const ctx = createTestContext();
    const events: RunEvent[] = [];

    const handler = (e: RunEvent) => events.push(e);
    eventBus.on(handler);

    runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    eventBus.off(handler);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("run:started");
    expect(events[0].agentName).toBe("test-agent");
    expect(events[1].type).toBe("run:completed");
  });

  it("emits run:failed event on handler error", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    const agent = createAgent({
      handler: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const ctx = createTestContext();
    const events: RunEvent[] = [];

    const handler = (e: RunEvent) => events.push(e);
    eventBus.on(handler);

    runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    eventBus.off(handler);

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("run:started");
    expect(events[1].type).toBe("run:failed");
    expect(events[1].data.error).toBe("boom");
  });

  it("persists run events to the database", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    const agent = createAgent();
    const ctx = createTestContext();

    runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    const allEvents = testDb.select().from(runEvents).all();
    expect(allEvents).toHaveLength(2);
    expect(allEvents.map((e) => e.type)).toEqual(["run:started", "run:completed"]);
  });

  it("kill aborts a running job and emits run:failed", async () => {
    const runner = createRunner({ maxConcurrency: 5 });
    let resolveHandler!: () => void;
    const agent = createAgent({
      handler: vi.fn(
        () => new Promise<void>((resolve) => {
          resolveHandler = resolve;
        }),
      ),
    });
    const ctx = createTestContext();
    const events: RunEvent[] = [];

    const handler = (e: RunEvent) => events.push(e);
    eventBus.on(handler);

    const runId = runner.enqueue(agent, ctx);
    await new Promise((r) => setTimeout(r, 10));

    // Run should be started but not completed
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("run:started");

    // Kill the run
    const killed = runner.kill(runId);
    expect(killed).toBe(true);
    await new Promise((r) => setTimeout(r, 10));

    eventBus.off(handler);

    // Should have emitted run:failed
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("run:failed");
    expect(events[1].data.error).toBe("Run killed by user");

    // DB should reflect failed status
    const allRuns = testDb.select().from(runs).all();
    expect(allRuns[0].status).toBe("failed");
    expect(allRuns[0].error).toBe("Run killed by user");

    // Clean up the dangling handler promise
    resolveHandler();
  });

  it("kill returns false for unknown run id", () => {
    const runner = createRunner({ maxConcurrency: 5 });
    expect(runner.kill("nonexistent")).toBe(false);
  });
});
