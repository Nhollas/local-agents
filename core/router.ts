import type { AgentDefinition } from "./types.ts";

/**
 * Match a webhook event+action against registered agents.
 *
 * Automatic triggers: match on event + action (or wildcard action).
 * All matching automatic agents are returned.
 *
 * Command triggers: match on event + action + command prefix in the
 * comment body. Only the first matching command agent is returned.
 * Command agents are mutually exclusive — at most one fires per event.
 *
 * When both types match, both are returned (command agent + all automatic agents).
 */
export function route(
  event: string,
  action: string,
  agents: AgentDefinition[],
  payload?: Record<string, unknown>,
): AgentDefinition[] {
  const commentBody = extractCommentBody(payload);
  const matched: AgentDefinition[] = [];

  for (const agent of agents) {
    for (const t of agent.triggers) {
      if (t.event !== event) continue;
      if (t.action !== undefined && t.action !== action) continue;

      if (t.command) {
        // Command trigger — match command prefix in comment body
        if (commentBody !== null && commentBody.trim().toLowerCase().startsWith(t.command.toLowerCase())) {
          matched.push(agent);
        }
      } else {
        // Automatic trigger — all matching agents fire
        matched.push(agent);
      }
      break; // Only need one trigger to match per agent
    }
  }

  return matched;
}

function extractCommentBody(payload?: Record<string, unknown>): string | null {
  if (!payload) return null;
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (comment && typeof comment.body === "string") {
    return comment.body;
  }
  return null;
}
