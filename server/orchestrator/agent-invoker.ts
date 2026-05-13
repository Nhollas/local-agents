import { query } from "@anthropic-ai/claude-agent-sdk";
import type { IssueKey, RunId } from "../types/brands.ts";
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
			const resolvedEnv = {
				...baseEnv,
				...buildOtelEnv({ runId, issueKey, stepName }),
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

function buildOtelEnv({
	runId,
	issueKey,
	stepName,
}: {
	runId: RunId;
	issueKey: IssueKey | undefined;
	stepName: string | undefined;
}): Record<string, string> {
	const publicKey = process.env["LANGFUSE_PUBLIC_KEY"];
	const secretKey = process.env["LANGFUSE_SECRET_KEY"];
	if (!publicKey || !secretKey) return {};

	const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString(
		"base64",
	);

	const resourceParts = [`service.name=local-agents`, `run.id=${runId}`];
	if (issueKey) resourceParts.push(`issue.key=${issueKey}`);
	if (stepName) resourceParts.push(`workflow.step=${stepName}`);

	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: "1",
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:3000/api/public/otel",
		OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${credentials}`,
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		OTEL_LOG_USER_PROMPTS: "1",
		OTEL_LOG_TOOL_DETAILS: "1",
		OTEL_LOG_TOOL_CONTENT: "1",
		OTEL_TRACES_EXPORT_INTERVAL: "1000",
		OTEL_METRICS_EXPORT_INTERVAL: "1000",
		OTEL_LOGS_EXPORT_INTERVAL: "1000",
		OTEL_RESOURCE_ATTRIBUTES: resourceParts.join(","),
	};
}
