import type { AgentDefinition } from "./types.ts";

/**
 * Match a webhook event+action against registered agents.
 *
 * A trigger matches when:
 * - trigger.event === event
 * - AND trigger.action === action OR trigger.action is undefined (wildcard)
 *
 * Returns all matching agents (may be empty).
 */
export function route(
  event: string,
  action: string,
  agents: AgentDefinition[],
): AgentDefinition[] {
  return agents.filter((agent) =>
    agent.triggers.some(
      (t) => t.event === event && (t.action === undefined || t.action === action),
    ),
  );
}
