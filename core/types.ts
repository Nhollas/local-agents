import type { Logger } from "pino";

/** A trigger declaration: which GitHub event (and optional action) an agent responds to. */
export type Trigger = {
  event: string;
  action?: string;
};

/** The context passed to every agent handler. */
export type WebhookContext = {
  event: string;
  action: string;
  payload: Record<string, unknown>;
  logger: Logger;
};

/** The definition of an agent, returned by defineAgent() and exported as default from agent modules. */
export type AgentDefinition = {
  name: string;
  triggers: Trigger[];
  handler: (ctx: WebhookContext) => Promise<void>;
};
