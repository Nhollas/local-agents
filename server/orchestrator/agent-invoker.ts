import { query } from "@anthropic-ai/claude-agent-sdk";
import type { RunId } from "../types/brands.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import { createRunLogWriter } from "./run-log-file.ts";

export type AgentMessage =
	ReturnType<typeof query> extends AsyncGenerator<infer T> ? T : never;

export type OutputFormat = {
	type: "json_schema";
	schema: Record<string, unknown>;
};

export type AgentInvokeOptions = {
	prompt: string;
	cwd: string;
	model: string;
	runId: RunId;
	resumeSessionId?: string;
	signal: AbortSignal;
	outputFormat?: OutputFormat;
	allowedTools?: readonly string[];
};

export type AgentInvoker = {
	invoke(opts: AgentInvokeOptions): AsyncIterable<AgentMessage>;
};

export const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"Task",
] as const;

export function claudeSdkAgentInvoker({
	env,
	logDir,
}: {
	env: Record<string, string>;
	logDir: string;
}): AgentInvoker {
	return {
		invoke({
			prompt,
			cwd,
			model,
			runId,
			resumeSessionId,
			outputFormat,
			signal,
			allowedTools,
		}) {
			const runLogWriter = createRunLogWriter(logDir, runId);
			return query({
				prompt,
				options: {
					cwd,
					model,
					env,
					abortController: abortControllerFromSignal(signal),
					allowedTools: [...(allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
					permissionMode: "dontAsk" as const,
					settingSources: ["project"],
					systemPrompt: {
						type: "preset",
						preset: "claude_code",
						excludeDynamicSections: true,
					},
					hooks: buildAgentHooks(runLogWriter),
					...(resumeSessionId && { resume: resumeSessionId }),
					...(outputFormat && { outputFormat }),
				},
			});
		},
	};
}

function abortControllerFromSignal(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	return controller;
}
