import { readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentDefinition, Trigger } from "./types.ts";
import { logger } from "./logger.ts";

function isValidTrigger(value: unknown): value is Trigger {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  if (typeof t.event !== "string") return false;
  if ("action" in t && typeof t.action !== "string") return false;
  return true;
}

function isValidDefinition(value: unknown): value is AgentDefinition {
  if (typeof value !== "object" || value === null) return false;
  const def = value as Record<string, unknown>;
  if (typeof def.name !== "string" || def.name.length === 0) return false;
  if (!Array.isArray(def.triggers) || def.triggers.length === 0) return false;
  if (!def.triggers.every(isValidTrigger)) return false;
  if (typeof def.handler !== "function") return false;
  return true;
}

/**
 * Load all agent definitions from a directory.
 * Expects: <agentsDir>/<name>/agent.ts with a default export.
 */
export async function loadRegistry(agentsDir: string): Promise<AgentDefinition[]> {
  const absoluteDir = resolve(agentsDir);

  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch {
    logger.warn({ dir: absoluteDir }, "registry.dir_not_found");
    return [];
  }

  const agents: AgentDefinition[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentFile = join(absoluteDir, entry.name, "agent.ts");
    const fileUrl = pathToFileURL(agentFile).href;

    try {
      const mod = await import(fileUrl);
      const definition = mod.default;

      if (!isValidDefinition(definition)) {
        logger.warn({ agent: entry.name, path: agentFile }, "registry.invalid_definition");
        continue;
      }

      agents.push(definition);
      logger.info({ agent: definition.name, triggers: definition.triggers }, "registry.loaded");
    } catch (err) {
      logger.warn({ agent: entry.name, err }, "registry.load_failed");
    }
  }

  return agents;
}
