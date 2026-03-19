import { getPrDiff, postComment, cloneAndCheckout } from "./gh.ts";
import type { AgentContext, ContextDeps } from "./types.ts";
import type { Logger } from "pino";

const defaultDeps: ContextDeps = {
  getPrDiff,
  postComment,
  cloneAndCheckout,
};

type CreateAgentContextParams = {
  event: string;
  action: string;
  payload: Record<string, unknown>;
  logger: Logger;
  model: string;
};

/** Create the rich context object injected into agent handlers. */
export function createAgentContext(
  params: CreateAgentContextParams,
  deps: Partial<ContextDeps> = {},
): AgentContext {
  const resolved: ContextDeps = { ...defaultDeps, ...deps };

  const repo = extractRepo(params.payload);
  const prNumber = extractPrNumber(params.payload);
  const headBranch = extractHeadBranch(params.payload);

  return {
    event: params.event,
    action: params.action,
    payload: params.payload,
    logger: params.logger,
    model: params.model,
    repo,
    prNumber,
    headBranch,
    diff: () => resolved.getPrDiff(repo, prNumber),
    clone: (targetDir: string) => resolved.cloneAndCheckout(repo, headBranch, targetDir),
    comment: (body: string) => resolved.postComment(repo, prNumber, body),
  };
}

function extractRepo(payload: Record<string, unknown>): string {
  const repository = payload.repository as Record<string, unknown> | undefined;
  if (repository && typeof repository.full_name === "string") {
    return repository.full_name;
  }
  return "";
}

function extractPrNumber(payload: Record<string, unknown>): number {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (pr && typeof pr.number === "number") {
    return pr.number;
  }
  const issue = payload.issue as Record<string, unknown> | undefined;
  if (issue && typeof issue.number === "number") {
    return issue.number;
  }
  return 0;
}

function extractHeadBranch(payload: Record<string, unknown>): string {
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (pr) {
    const head = pr.head as Record<string, unknown> | undefined;
    if (head && typeof head.ref === "string") {
      return head.ref;
    }
  }
  return "";
}
