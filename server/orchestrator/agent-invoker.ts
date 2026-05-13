import { query } from "@anthropic-ai/claude-agent-sdk";
import { context as otelContext, propagation } from "@opentelemetry/api";
import type { IssueKey, RunId } from "../types/brands.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import { buildOtelEnv } from "./otel-env.ts";
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
	issueKey?: IssueKey;
	stepName?: string;
	env?: Record<string, string>;
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
	"Agent",
] as const;

export type LangfuseConfig = {
	publicKey: string;
	secretKey: string;
	host: string;
	baseUrl: string;
	projectId: string | undefined;
};

export function claudeSdkAgentInvoker({
	env,
	logDir,
	langfuse,
}: {
	env: Record<string, string>;
	logDir: string;
	langfuse: LangfuseConfig;
}): AgentInvoker {
	return {
		invoke({
			prompt,
			cwd,
			model,
			runId,
			issueKey,
			stepName,
			env: invocationEnv,
			resumeSessionId,
			outputFormat,
			signal,
			allowedTools,
		}) {
			const runLogWriter = createRunLogWriter(logDir, runId);
			const baseEnv = invocationEnv ?? env;
			const propagationCarrier: Record<string, string> = {};
			propagation.inject(otelContext.active(), propagationCarrier);
			const resolvedEnv = {
				...baseEnv,
				...buildOtelEnv({ runId, issueKey, stepName, langfuse }),
				...(propagationCarrier["traceparent"] && {
					TRACEPARENT: propagationCarrier["traceparent"],
				}),
				...(propagationCarrier["tracestate"] && {
					TRACESTATE: propagationCarrier["tracestate"],
				}),
			};
			return query({
				prompt,
				options: {
					cwd,
					model,
					env: resolvedEnv,
					abortController: abortControllerFromSignal(signal),
					allowedTools: [...(allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
					permissionMode: "dontAsk" as const,
					settingSources: ["project"],
					// Auto-enables the Skill tool so skills like `implement` can chain
					// into others (e.g. `tdd`). Without this, `permissionMode: "dontAsk"`
					// denies Skill because it isn't in `allowedTools`, and listing
					// `"Skill"` there is deprecated (sdk.d.ts: use `skills` instead).
					skills: "all",
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
