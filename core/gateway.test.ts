import { describe, expect, it, vi } from "vitest";
import { createGateway } from "./gateway.ts";
import { createWebhookRequest } from "../tests/support/webhook.ts";
import type { AgentDefinition } from "./types.ts";

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

const SECRET = "test-secret";

function createAgent(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name: "test-agent",
    triggers: [{ event: "pull_request", action: "opened" }],
    handler: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("createGateway", () => {
  it("returns 401 for an invalid signature", async () => {
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [] });

    const req = new Request("http://localhost/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=invalid",
      },
      body: JSON.stringify({ action: "opened" }),
    });

    const res = await app.request(req);
    expect(res.status).toBe(401);
  });

  it("returns 202 and calls handler for a matching agent", async () => {
    const agent = createAgent();
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [agent] });

    const req = createWebhookRequest(SECRET, "pull_request", { action: "opened" });
    const res = await app.request(req);

    expect(res.status).toBe(202);
    // Allow microtask queue to flush
    await new Promise((r) => setTimeout(r, 0));
    expect(agent.handler).toHaveBeenCalledOnce();
  });

  it("returns 200 when no agents match", async () => {
    const agent = createAgent();
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [agent] });

    const req = createWebhookRequest(SECRET, "issues", { action: "opened" });
    const res = await app.request(req);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("No matching agents");
  });

  it("returns 202 even when a handler throws", async () => {
    const agent = createAgent({
      handler: vi.fn(async () => {
        throw new Error("handler failed");
      }),
    });
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [agent] });

    const req = createWebhookRequest(SECRET, "pull_request", { action: "opened" });
    const res = await app.request(req);

    expect(res.status).toBe(202);
  });

  it("dispatches multiple matching agents", async () => {
    const a = createAgent({ name: "agent-a" });
    const b = createAgent({ name: "agent-b" });
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [a, b] });

    const req = createWebhookRequest(SECRET, "pull_request", { action: "opened" });
    const res = await app.request(req);

    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 0));
    expect(a.handler).toHaveBeenCalledOnce();
    expect(b.handler).toHaveBeenCalledOnce();
  });

  it("returns 200 OK for GET /health", async () => {
    const { app } = createGateway({ secret: SECRET, model: "test-model", agents: [] });
    const res = await app.request("http://localhost/health");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("OK");
  });
});
