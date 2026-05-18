import type { Issue } from "../trackers/types.ts";
import { renderPrompt } from "../workflow/render-prompt.ts";
import type { ChangeRequestTemplate } from "../workflow/types.ts";

type RenderChangeRequestParams = {
	template: ChangeRequestTemplate;
	issue: Issue;
	branch: string;
	outputs?: Record<string, unknown>;
};

export function renderChangeRequest({
	template,
	issue,
	branch,
	outputs,
}: RenderChangeRequestParams): { title: string; body: string } {
	const vars = { issue, branch, outputs };
	return {
		title: renderPrompt(template.title, vars),
		body: renderPrompt(template.body, vars),
	};
}
