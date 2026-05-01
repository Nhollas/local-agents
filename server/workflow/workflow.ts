import { parse } from "yaml";
import { z } from "zod";
import type { Issue } from "../trackers/types.ts";
import { stripShellBlockMarkers } from "./prompt-preprocessor.ts";

const workflowPhaseSchema = z.object({
	name: z.string().min(1),
	prompt: z.string(),
	resume_previous: z.boolean().optional().default(false),
});

export type WorkflowPhase = z.infer<typeof workflowPhaseSchema>;

const repoWorkflowSchema = z
	.object({
		branch: z.string().min(1),
		base_branch: z.string().min(1),
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
	})
	.transform(({ prompt, phases, ...rest }) => {
		if (phases) return { ...rest, phases };
		/* v8 ignore next 3 -- unreachable; superRefine guarantees prompt is set when phases is not */
		if (prompt == null) {
			throw new Error("Invariant: workflow has neither prompt nor phases");
		}
		return {
			...rest,
			phases: [{ name: "prompt", prompt, resume_previous: false }],
		};
	});

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
	vars: { issue: Issue; attempt?: number },
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
