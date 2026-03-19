import { describe, expect, it, vi } from "vitest";
import { createAgentContext } from "./context.ts";
import type { ContextDeps } from "./types.ts";

vi.mock("./gh.ts", () => ({
  getPrDiff: vi.fn(),
  postComment: vi.fn(),
  cloneAndCheckout: vi.fn(),
}));

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as any;

function prPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "opened",
    repository: { full_name: "owner/repo" },
    pull_request: { number: 42, head: { ref: "feature-branch" } },
    ...overrides,
  };
}

function issueCommentPayload() {
  return {
    action: "created",
    repository: { full_name: "owner/repo" },
    issue: { number: 7 },
    comment: { id: 1, body: "/check" },
  };
}

function baseParams(payload: Record<string, unknown> = prPayload()) {
  return {
    event: "pull_request",
    action: "opened",
    payload,
    logger: mockLogger,
    model: "claude-sonnet-4-6",
  };
}

function mockDeps(): ContextDeps {
  return {
    getPrDiff: vi.fn(async () => "diff content"),
    postComment: vi.fn(async () => 123),
    cloneAndCheckout: vi.fn(async () => {}),
  };
}

describe("createAgentContext", () => {
  it("extracts repo from pull_request payload", () => {
    const ctx = createAgentContext(baseParams(), mockDeps());
    expect(ctx.repo).toBe("owner/repo");
  });

  it("extracts prNumber from pull_request payload", () => {
    const ctx = createAgentContext(baseParams(), mockDeps());
    expect(ctx.prNumber).toBe(42);
  });

  it("extracts headBranch from pull_request payload", () => {
    const ctx = createAgentContext(baseParams(), mockDeps());
    expect(ctx.headBranch).toBe("feature-branch");
  });

  it("extracts prNumber from issue_comment payload", () => {
    const ctx = createAgentContext(
      baseParams(issueCommentPayload()),
      mockDeps(),
    );
    expect(ctx.prNumber).toBe(7);
  });

  it("defaults repo to empty string when repository is missing", () => {
    const ctx = createAgentContext(baseParams({}), mockDeps());
    expect(ctx.repo).toBe("");
  });

  it("defaults prNumber to 0 when neither pull_request nor issue is present", () => {
    const ctx = createAgentContext(baseParams({}), mockDeps());
    expect(ctx.prNumber).toBe(0);
  });

  it("defaults headBranch to empty string when pull_request is missing", () => {
    const ctx = createAgentContext(
      baseParams(issueCommentPayload()),
      mockDeps(),
    );
    expect(ctx.headBranch).toBe("");
  });

  it("diff() delegates to getPrDiff with repo and prNumber", async () => {
    const deps = mockDeps();
    const ctx = createAgentContext(baseParams(), deps);
    const result = await ctx.diff();
    expect(deps.getPrDiff).toHaveBeenCalledWith("owner/repo", 42);
    expect(result).toBe("diff content");
  });

  it("clone() delegates to cloneAndCheckout with repo, headBranch, and targetDir", async () => {
    const deps = mockDeps();
    const ctx = createAgentContext(baseParams(), deps);
    await ctx.clone("/tmp/work");
    expect(deps.cloneAndCheckout).toHaveBeenCalledWith(
      "owner/repo",
      "feature-branch",
      "/tmp/work",
    );
  });

  it("comment() delegates to postComment with repo, prNumber, and body", async () => {
    const deps = mockDeps();
    const ctx = createAgentContext(baseParams(), deps);
    const id = await ctx.comment("Hello!");
    expect(deps.postComment).toHaveBeenCalledWith("owner/repo", 42, "Hello!");
    expect(id).toBe(123);
  });

  it("passes through event, action, payload, logger, and model", () => {
    const params = baseParams();
    const ctx = createAgentContext(params, mockDeps());
    expect(ctx.event).toBe("pull_request");
    expect(ctx.action).toBe("opened");
    expect(ctx.payload).toBe(params.payload);
    expect(ctx.logger).toBe(mockLogger);
    expect(ctx.model).toBe("claude-sonnet-4-6");
  });

  it("partial deps override only the specified function", async () => {
    const customDiff = vi.fn(async () => "custom diff");
    const ctx = createAgentContext(baseParams(), { getPrDiff: customDiff });
    const result = await ctx.diff();
    expect(customDiff).toHaveBeenCalledWith("owner/repo", 42);
    expect(result).toBe("custom diff");
  });
});
