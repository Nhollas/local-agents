import { describe, expect, it } from "vitest";
import { route } from "./router.ts";
import type { AgentDefinition } from "./types.ts";

function createAgent(
  overrides: Partial<AgentDefinition> = {},
): AgentDefinition {
  return {
    name: "test-agent",
    triggers: [{ event: "pull_request", action: "opened" }],
    handler: async () => {},
    ...overrides,
  };
}

describe("route", () => {
  describe("automatic triggers", () => {
    it("returns the matching agent", () => {
      const agent = createAgent();
      const result = route("pull_request", "opened", [agent]);
      expect(result).toEqual([agent]);
    });

    it("returns empty when event does not match", () => {
      const agent = createAgent();
      const result = route("issues", "opened", [agent]);
      expect(result).toEqual([]);
    });

    it("returns empty when action does not match", () => {
      const agent = createAgent();
      const result = route("pull_request", "closed", [agent]);
      expect(result).toEqual([]);
    });

    it("matches a trigger with no action (wildcard)", () => {
      const agent = createAgent({
        triggers: [{ event: "pull_request" }],
      });
      const result = route("pull_request", "reopened", [agent]);
      expect(result).toEqual([agent]);
    });

    it("returns multiple agents that match the same event", () => {
      const a = createAgent({ name: "agent-a" });
      const b = createAgent({ name: "agent-b" });
      const result = route("pull_request", "opened", [a, b]);
      expect(result).toEqual([a, b]);
    });

    it("matches when any of multiple triggers match", () => {
      const agent = createAgent({
        triggers: [
          { event: "pull_request", action: "opened" },
          { event: "pull_request", action: "synchronize" },
        ],
      });
      const result = route("pull_request", "synchronize", [agent]);
      expect(result).toEqual([agent]);
    });

    it("returns empty for an empty agents array", () => {
      const result = route("pull_request", "opened", []);
      expect(result).toEqual([]);
    });

    it("returns only matching agents from a mixed set", () => {
      const a = createAgent({ name: "pr-agent", triggers: [{ event: "pull_request", action: "opened" }] });
      const b = createAgent({ name: "issue-agent", triggers: [{ event: "issues", action: "opened" }] });
      const c = createAgent({ name: "another-pr-agent", triggers: [{ event: "pull_request", action: "opened" }] });

      const result = route("pull_request", "opened", [a, b, c]);
      expect(result).toEqual([a, c]);
    });
  });

  describe("command triggers", () => {
    it("matches when comment body starts with the command", () => {
      const agent = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const payload = { comment: { body: "/check" } };
      const result = route("issue_comment", "created", [agent], payload);
      expect(result).toEqual([agent]);
    });

    it("does not match when comment body has a different command", () => {
      const agent = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const payload = { comment: { body: "/deploy" } };
      const result = route("issue_comment", "created", [agent], payload);
      expect(result).toEqual([]);
    });

    it("does not match when no payload is provided", () => {
      const agent = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const result = route("issue_comment", "created", [agent]);
      expect(result).toEqual([]);
    });

    it("matches case-insensitively", () => {
      const agent = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const payload = { comment: { body: "/CHECK" } };
      const result = route("issue_comment", "created", [agent], payload);
      expect(result).toEqual([agent]);
    });

    it("only returns the matching command agent, not others", () => {
      const check = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const go = createAgent({
        name: "go-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/go" }],
      });
      const payload = { comment: { body: "/check" } };
      const result = route("issue_comment", "created", [check, go], payload);
      expect(result).toEqual([check]);
    });

    it("returns both automatic and command agents when both match", () => {
      const auto = createAgent({
        name: "auto-agent",
        triggers: [{ event: "issue_comment", action: "created" }],
      });
      const command = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const payload = { comment: { body: "/check" } };
      const result = route("issue_comment", "created", [auto, command], payload);
      expect(result).toEqual([auto, command]);
    });

    it("matches with leading/trailing whitespace in comment", () => {
      const agent = createAgent({
        name: "check-agent",
        triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
      });
      const payload = { comment: { body: "  /check  " } };
      const result = route("issue_comment", "created", [agent], payload);
      expect(result).toEqual([agent]);
    });
  });
});
