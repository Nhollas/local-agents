import type { AgentDefinition } from "./types.ts";

/** Define an agent. Returns the definition unchanged — exists for type inference. */
export function defineAgent(definition: AgentDefinition): AgentDefinition {
  return definition;
}
