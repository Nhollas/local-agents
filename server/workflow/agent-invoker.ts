import type { query } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "effect";

export type AgentMessage =
	ReturnType<typeof query> extends AsyncGenerator<infer T> ? T : never;

export type OutputFormat = {
	type: "json_schema";
	schema: Record<string, unknown>;
};

export type AgentInvokeOptions = {
	prompt: string;
	model: string;
	stepName?: string | undefined;
	env?: Record<string, string> | undefined;
	resumeSessionId?: string | undefined;
	outputFormat?: OutputFormat | undefined;
	allowedTools?: readonly string[] | undefined;
	onToolFailure?: ((toolName: string) => void) | undefined;
};

export const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"Agent",
] as const;

export interface AgentInvokerService {
	readonly invoke: (opts: AgentInvokeOptions) => AsyncIterable<AgentMessage>;
}

export class AgentInvoker extends Context.Tag("AgentInvoker")<
	AgentInvoker,
	AgentInvokerService
>() {}
