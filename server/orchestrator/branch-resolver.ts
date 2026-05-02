import type { Issue } from "../trackers/types.ts";
import type { WorkflowBranch } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker, OutputFormat } from "./agent-invoker.ts";
import { logAgentMessage } from "./agent-logging.ts";

type ResolveBranchParams = {
	workflowBranch: WorkflowBranch;
	issue: Issue;
	attempt: number;
	agent: AgentInvoker;
	cwd: string;
	model: string;
	signal: AbortSignal;
};

export async function resolveBranch({
	workflowBranch,
	issue,
	attempt,
	agent,
	cwd,
	model,
	signal,
}: ResolveBranchParams): Promise<string> {
	if (typeof workflowBranch === "string") {
		return renderPrompt(workflowBranch, { issue, attempt });
	}

	const prompt = renderPrompt(workflowBranch.prompt, { issue, attempt });
	const outputFormat: OutputFormat = {
		type: "json_schema",
		schema: workflowBranch.schema,
	};

	for await (const msg of agent.invoke({
		prompt,
		cwd,
		model,
		signal,
		outputFormat,
	})) {
		if (msg.type === "assistant") {
			logAgentMessage(msg, cwd);
			continue;
		}
		if (msg.type !== "result") continue;
		if (msg.subtype === "success") {
			const value = msg.structured_output as { name?: unknown };
			if (typeof value?.name !== "string" || value.name.length === 0) {
				throw new Error(
					"branch agent returned no `name` field in structured output",
				);
			}
			return value.name;
		}
		throw new Error(msg.subtype);
	}

	throw new Error("branch agent stream ended without a result message");
}
