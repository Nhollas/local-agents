import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Issue, WorkflowDefinition } from "./types.ts";

const workflowSchema = z.object({
  tracker: z.object({
    kind: z.literal("github"),
    repo: z.string(),
    label: z.string().default("agent"),
    active_states: z.array(z.string()).default(["open"]),
    terminal_states: z.array(z.string()).default(["closed"]),
  }),
  polling: z
    .object({
      interval_ms: z.number().default(30000),
    })
    .optional()
    .transform((v) => v ?? { interval_ms: 30000 }),
  agent: z
    .object({
      max_concurrent: z.number().default(2),
      timeout_ms: z.number().default(3600000),
      model: z.string().default("claude-sonnet-4-6"),
    })
    .optional()
    .transform((v) => v ?? { max_concurrent: 2, timeout_ms: 3600000, model: "claude-sonnet-4-6" }),
  workspace: z
    .object({
      root: z.string().default("/tmp/local-agent-workspaces"),
    })
    .optional()
    .transform((v) => v ?? { root: "/tmp/local-agent-workspaces" }),
  hooks: z
    .object({
      after_create: z.string().optional(),
      before_run: z.string().optional(),
      after_run: z.string().optional(),
    })
    .optional(),
  prompt: z.string(),
});

export function loadWorkflow(filePath: string): WorkflowDefinition {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parse(raw);
  const validated = workflowSchema.parse(parsed);

  const { prompt, ...config } = validated;
  return { config, prompt };
}

/**
 * Render a prompt template with `{{ variable.path }}` interpolation.
 */
export function renderPrompt(
  template: string,
  vars: { issue: Issue; attempt?: number },
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
    const parts = path.split(".");
    let value: unknown = vars;
    for (const part of parts) {
      if (value == null || typeof value !== "object") return "";
      value = (value as Record<string, unknown>)[part];
    }
    if (value == null) return "";
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  });
}
