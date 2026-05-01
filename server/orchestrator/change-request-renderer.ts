import type { Issue } from "../trackers/types.ts";
import type { BranchName } from "../types/brands.ts";
import type { ChangeRequestTemplate } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";

type RenderChangeRequestParams = {
	template: ChangeRequestTemplate;
	issue: Issue;
	attempt: number;
	branch: BranchName;
	outputs?: Record<string, unknown>;
};

export function renderChangeRequest({
	template,
	issue,
	attempt,
	branch,
	outputs,
}: RenderChangeRequestParams): { title: string; body: string } {
	const vars = { issue, attempt, branch, outputs };
	return {
		title: renderPrompt(template.title, vars),
		body: renderPrompt(template.body, vars),
	};
}
