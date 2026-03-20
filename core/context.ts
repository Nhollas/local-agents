import { getPrDetails, getPrDiff, postComment, cloneAndCheckout } from "./gh.ts";
import type { AgentContext, ContextDeps } from "./types.ts";
import type { Logger } from "pino";

const defaultDeps: ContextDeps = {
  getPrDetails,
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
export async function createAgentContext(
  params: CreateAgentContextParams,
  deps: Partial<ContextDeps> = {},
): Promise<AgentContext> {
  const resolved: ContextDeps = { ...defaultDeps, ...deps };

  const repo = extractRepo(params.payload);
  const prNumber = extractPrNumber(params.payload);
  let headBranch = extractHeadBranch(params.payload);

  // issue_comment payloads don't include the head branch — fetch it from the API
  if (!headBranch && repo && prNumber) {
    const details = await resolved.getPrDetails(repo, prNumber);
    headBranch = details.headBranch;
  }

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
    emitToolUse: () => {},
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
