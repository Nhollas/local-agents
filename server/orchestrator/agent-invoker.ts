import { query } from "@anthropic-ai/claude-agent-sdk";

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
	resumeSessionId?: string;
	signal: AbortSignal;
	outputFormat?: OutputFormat;
};

export type AgentInvoker = {
	invoke(opts: AgentInvokeOptions): AsyncIterable<AgentMessage>;
};

export const ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
] as const;

export function claudeSdkAgentInvoker(): AgentInvoker {
	return {
		invoke({ prompt, cwd, model, resumeSessionId, outputFormat, signal }) {
			return query({
				prompt,
				options: {
					cwd,
					model,
					abortController: abortControllerFromSignal(signal),
					allowedTools: [...ALLOWED_TOOLS],
					permissionMode: "dontAsk" as const,
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
