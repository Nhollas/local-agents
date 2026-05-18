import type { query } from "@anthropic-ai/claude-agent-sdk";
import { Context } from "effect";
import type { IssueKey, RunId } from "../types/brands.ts";

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
	issueKey?: IssueKey;
	stepName?: string;
	env?: Record<string, string>;
	resumeSessionId?: string;
	signal: AbortSignal;
	outputFormat?: OutputFormat;
	allowedTools?: readonly string[];
	onToolFailure?: (toolName: string) => void;
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

export class AgentInvoker extends Context.Tag("AgentInvoker")<
	AgentInvoker,
	{
		readonly invoke: (opts: AgentInvokeOptions) => AsyncIterable<AgentMessage>;
	}
>() {}

export type AgentInvokerService = Context.Tag.Service<typeof AgentInvoker>;
