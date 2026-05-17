import { Schema } from "effect";
import type { RunRepository } from "../run-repository.ts";
import type { Issue } from "../trackers/types.ts";
import type { RunId } from "../types/brands.ts";
import type { WorkflowBranch } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker, OutputFormat } from "./agent-invoker.ts";
import { trackAgentToolUseBag } from "./agent-logging.ts";
import { recordAgentResult } from "./agent-metrics.ts";

const decodeBranchOutput = Schema.decodeUnknownEither(
	Schema.Struct({ name: Schema.String.pipe(Schema.minLength(1)) }),
);

type ResolveBranchParams = {
	workflowBranch: WorkflowBranch;
	issue: Issue;
	agent: AgentInvoker;
	runRepo: Pick<RunRepository, "addRunUsage">;
	cwd: string;
	runId: RunId;
	signal: AbortSignal;
};

export async function resolveBranch({
	workflowBranch,
	issue,
	agent,
	runRepo,
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

	let costUsd = 0;
	let tokensInput = 0;
	let tokensOutput = 0;

	try {
		for await (const msg of agent.invoke({
			prompt,
			cwd,
			model: workflowBranch.model,
			runId,
			issueKey: issue.key,
			signal,
			outputFormat,
		})) {
			if (msg.type === "assistant") {
				trackAgentToolUseBag(msg);
				continue;
			}
			if (msg.type !== "result") continue;
			recordAgentResult(msg);
			costUsd += msg.total_cost_usd;
			for (const usage of Object.values(msg.modelUsage)) {
				tokensInput += usage.inputTokens;
				tokensOutput += usage.outputTokens;
			}
			if (msg.subtype === "success") {
				const parsed = decodeBranchOutput(msg.structured_output);
				if (parsed._tag === "Left") {
					throw new Error(
						"branch agent returned no `name` field in structured output",
					);
				}
				return parsed.right.name;
			}
			throw new Error(msg.subtype);
		}

		throw new Error("branch agent stream ended without a result message");
	} finally {
		if (costUsd > 0 || tokensInput > 0 || tokensOutput > 0) {
			runRepo.addRunUsage(runId, { costUsd, tokensInput, tokensOutput });
		}
	}
}
