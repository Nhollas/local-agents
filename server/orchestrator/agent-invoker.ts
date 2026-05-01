import { query } from "@anthropic-ai/claude-agent-sdk";

export type AgentMessage =
	ReturnType<typeof query> extends AsyncGenerator<infer T> ? T : never;

export type AgentInvokeOptions = {
	prompt: string;
	cwd: string;
	model: string;
	resumeSessionId?: string;
	signal: AbortSignal;
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
		invoke({ prompt, cwd, model, resumeSessionId }) {
			return query({
				prompt,
				options: {
					cwd,
					model,
					allowedTools: [...ALLOWED_TOOLS],
					permissionMode: "dontAsk" as const,
					...(resumeSessionId && { resume: resumeSessionId }),
				},
			});
		},
	};
}
