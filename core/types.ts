import type { Logger } from "pino";

/** A trigger declaration: which GitHub event (and optional action) an agent responds to. */
export type Trigger = {
  event: string;
  action?: string;
};

/** Dependencies injected into the context factory. Tests can override these. */
export type ContextDeps = {
  getPrDiff: (repo: string, prNumber: number) => Promise<string>;
  postComment: (repo: string, prNumber: number, body: string) => Promise<number>;
  cloneAndCheckout: (repo: string, branch: string, targetDir: string) => Promise<void>;
};

/** The rich context passed to every agent handler. */
export type AgentContext = {
  event: string;
  action: string;
  payload: Record<string, unknown>;
  logger: Logger;
  model: string;
  repo: string;
  prNumber: number;
  headBranch: string;
  /** Fetch the PR diff. */
  diff: () => Promise<string>;
  /** Clone the repo at the PR's head branch into targetDir. */
  clone: (targetDir: string) => Promise<void>;
  /** Post a comment on the PR. Returns the comment ID. */
  comment: (body: string) => Promise<number>;
};

/** The definition of an agent, returned by defineAgent() and exported as default from agent modules. */
export type AgentDefinition = {
  name: string;
  triggers: Trigger[];
  handler: (ctx: AgentContext) => Promise<void>;
};
