import { renderPrompt } from "./render-prompt.ts";
import type { ChangeRequestTemplate, PromptScope } from "./types.ts";

export function renderChangeRequest(
	template: ChangeRequestTemplate,
	scope: PromptScope,
	branch: string,
	outputs: Record<string, unknown>,
): { title: string; body: string } {
	const vars = {
		issue: scope.issue,
		branch,
		base_branch: scope.baseBranch,
		outputs,
	};
	return {
		title: renderPrompt(template.title, vars),
		body: renderPrompt(template.body, vars),
	};
}
