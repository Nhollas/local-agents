import { z } from "zod";
import type { Issue } from "../trackers/types.ts";
import type { RunId } from "../types/brands.ts";
import type { WorkflowBranch } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker, OutputFormat } from "./agent-invoker.ts";
import { trackAgentToolUseBag } from "./agent-logging.ts";
import { recordAgentResult } from "./agent-metrics.ts";

const branchOutputSchema = z.object({ name: z.string().min(1) });

type ResolveBranchParams = {
	workflowBranch: WorkflowBranch;
	issue: Issue;
	agent: AgentInvoker;
	cwd: string;
	runId: RunId;
	signal: AbortSignal;
};

export async function resolveBranch({
	workflowBranch,
	issue,
	agent,
	cwd,
	runId,
	signal,
}: ResolveBranchParams): Promise<string> {
	if (typeof workflowBranch === "string") {
		return renderPrompt(workflowBranch, { issue });
	}

	const prompt = renderPrompt(workflowBranch.prompt, { issue });
	const outputFormat: OutputFormat = {
		type: "json_schema",
		schema: workflowBranch.schema,
	};

	for await (const msg of agent.invoke({
		prompt,
		cwd,
		model: workflowBranch.model,
		runId,
		signal,
		outputFormat,
	})) {
		if (msg.type === "assistant") {
			trackAgentToolUseBag(msg);
			continue;
		}
		if (msg.type !== "result") continue;
		recordAgentResult(msg);
		if (msg.subtype === "success") {
			const parsed = branchOutputSchema.safeParse(msg.structured_output);
			if (!parsed.success) {
				throw new Error(
					"branch agent returned no `name` field in structured output",
				);
			}
			return parsed.data.name;
		}
		throw new Error(msg.subtype);
	}

	throw new Error("branch agent stream ended without a result message");
}
