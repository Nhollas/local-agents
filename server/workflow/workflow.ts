import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "../trackers/types.ts";
import { stripShellBlockMarkers } from "./prompt-preprocessor.ts";

const workflowStepSchema = z
	.object({
		name: z.string().min(1),
		prompt: z.string(),
		resume_previous: z.boolean().optional().default(false),
		output_schema: z.record(z.string(), z.unknown()).optional(),
	})
	.strict();

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

const changeRequestSchema = z
	.object({
		title: z.string().min(1),
		body: z.string().min(1),
	})
	.strict();

export type ChangeRequestTemplate = z.infer<typeof changeRequestSchema>;

const repoWorkflowSchema = z
	.object({
		branch: z.string().min(1),
		base_branch: z.string().min(1),
		steps: z.array(workflowStepSchema).min(1),
		change_request: changeRequestSchema,
	})
	.strict();

export type RepoWorkflow = z.infer<typeof repoWorkflowSchema>;

export function parseRepoWorkflow(yamlContent: string): RepoWorkflow {
	return repoWorkflowSchema.parse(parse(yamlContent));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

/**
 * Render a prompt template with `{{ variable.path }}` interpolation.
 */
export function renderPrompt(
	template: string,
	vars: { issue: Issue; attempt?: number; branch?: string },
): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
		const parts = path.split(".");
		let value: unknown = vars;
		for (const part of parts) {
			if (!isRecord(value)) return "";
			value = value[part];
		}
		if (value == null) return "";
		if (Array.isArray(value))
			return stripShellBlockMarkers(
				value.map((item) => String(item)).join(", "),
			);
		return stripShellBlockMarkers(String(value));
	});
}
