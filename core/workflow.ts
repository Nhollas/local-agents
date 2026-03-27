import { parse } from "yaml";
import { z } from "zod";
import type { Issue, RepoWorkflow } from "./types.ts";

const repoWorkflowSchema = z.object({
	label: z.string().default("agent"),
	completed_label: z.string().default("awaiting-review"),
	branch: z.string().default("agent/issue-{{ issue.number }}"),
	base_branch: z.string().default("main"),
	hooks: z
		.object({
			after_create: z.string().optional(),
			before_run: z.string().optional(),
			after_run: z.string().optional(),
		})
		.optional(),
	prompt: z.string(),
});

export function parseRepoWorkflow(yamlContent: string): RepoWorkflow {
	const parsed = parse(yamlContent);
	return repoWorkflowSchema.parse(parsed);
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
