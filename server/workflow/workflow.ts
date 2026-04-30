import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "../trackers/types.ts";
import { stripShellBlockMarkers } from "./prompt-preprocessor.ts";

const workflowPhaseSchema = z.object({
	name: z.string().min(1),
	prompt: z.string(),
	resume_previous: z.boolean().optional().default(false),
});

const repoWorkflowSchema = z
	.object({
		branch: z.string().default("agent/issue-{{ issue.number }}"),
		base_branch: z.string().default("main"),
		hooks: z
			.object({
				after_create: z.string().optional(),
				before_run: z.string().optional(),
				after_run: z.string().optional(),
			})
			.optional(),
		prompt: z.string().optional(),
		phases: z.array(workflowPhaseSchema).min(1).optional(),
	})
	.superRefine((workflow, ctx) => {
		const hasPrompt = workflow.prompt != null;
		const hasPhases = workflow.phases != null;
		if (hasPrompt === hasPhases) {
			ctx.addIssue({
				code: "custom",
				message: "Workflow must define exactly one of prompt or phases",
				path: hasPrompt ? ["phases"] : ["prompt"],
			});
		}
	});

export type WorkflowPhase = z.infer<typeof workflowPhaseSchema>;

export type RepoWorkflow = z.infer<typeof repoWorkflowSchema>;

export function getWorkflowPhases(workflow: RepoWorkflow): WorkflowPhase[] {
	if (workflow.phases) return workflow.phases;
	return [
		{
			name: "prompt",
			prompt: workflow.prompt as string,
			resume_previous: false,
		},
	];
}

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
		if (Array.isArray(value))
			return stripShellBlockMarkers(
				value.map((item) => String(item)).join(", "),
			);
		return stripShellBlockMarkers(String(value));
	});
}
