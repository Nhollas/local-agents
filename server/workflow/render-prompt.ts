import type { Issue } from "../trackers/types.ts";
import { stripShellBlockMarkers } from "./shell-expansion.ts";
import type { PromptIssue } from "./types.ts";

type RenderPromptVars = {
	issue: Issue | PromptIssue;
	branch?: string;
	base_branch?: string;
	outputs?: Record<string, unknown> | undefined;
};

export function renderPrompt(template: string, vars: RenderPromptVars): string {
	const scope: Record<string, unknown> = {
		issue: vars.issue,
		branch: vars.branch,
		base_branch: vars.base_branch,
		steps: Object.fromEntries(
			Object.entries(vars.outputs ?? {}).map(([name, output]) => [
				name,
				{ output },
			]),
		),
	};
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
		let value: unknown = scope;
		for (const part of path.split(".")) {
			if (!isRecord(value)) return "";
			value = value[part];
		}
		if (value == null) return "";
		const rendered = Array.isArray(value)
			? value.map((item) => String(item)).join(", ")
			: typeof value === "object"
				? JSON.stringify(value)
				: String(value);
		return stripShellBlockMarkers(rendered);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
