import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "../trackers/types.ts";
import { modelIdSchema } from "../types/model-id.ts";
import { stripShellBlockMarkers } from "./prompt-preprocessor.ts";

const jsonSchemaDocument = z.record(z.string(), z.unknown());

const workflowStepSchema = z
	.object({
		name: z
			.string()
			.regex(
				/^\w+$/,
				"step name must contain only letters, digits, and underscores",
			),
		prompt: z.string(),
		resume_previous: z.boolean().optional().default(false),
		output_schema: jsonSchemaDocument.optional(),
		model: modelIdSchema,
		allowed_tools: z.array(z.string().min(1)).min(1).optional(),
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

const branchAgentSchema = z
	.object({
		prompt: z.string().min(1),
		schema: jsonSchemaDocument,
		model: modelIdSchema,
	})
	.strict();

const branchSchema = z.union([z.string().min(1), branchAgentSchema]);

export type WorkflowBranch = z.infer<typeof branchSchema>;

const repoWorkflowSchema = z
	.object({
		branch: branchSchema,
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
	vars: {
		issue: Issue;
		branch?: string;
		base_branch?: string;
		outputs?: Record<string, unknown> | undefined;
	},
): string {
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
		const parts = path.split(".");
		if (parts[0] === "steps") {
			return renderOutputReference(parts, vars.outputs ?? {});
		}
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

function renderOutputReference(
	parts: string[],
	outputs: Record<string, unknown>,
): string {
	const [, stepName, marker, ...rest] = parts;
	if (stepName === undefined || marker !== "output" || rest.length === 0)
		return "";
	let value: unknown = outputs[stepName];
	for (const key of rest) {
		if (!isRecord(value)) return "";
		value = value[key];
	}
	if (value == null) return "";
	if (typeof value === "object")
		return stripShellBlockMarkers(JSON.stringify(value));
	return stripShellBlockMarkers(String(value));
}
