import { context as otelContext, propagation } from "@opentelemetry/api";
import { instrumentedQuery } from "../telemetry/otel.ts";
import type { RunId } from "../types/brands.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import {
	type AgentInvokerService,
	DEFAULT_ALLOWED_TOOLS,
} from "./agent-invoker.ts";
import { createRunLogWriter } from "./run-log-file.ts";

export type AgentInvokerLiveParams = {
	env: Record<string, string>;
	logDir: string;
	cwd: string;
	runId: RunId;
	signal: AbortSignal;
};

export function claudeSdkAgentInvoker({
	env: runEnv,
	logDir,
	cwd,
	runId,
	signal,
}: AgentInvokerLiveParams): AgentInvokerService {
	return {
		invoke({
			prompt,
			model,
			env: invocationEnv,
			resumeSessionId,
			outputFormat,
			allowedTools,
			onToolFailure,
		}) {
			const runLogWriter = createRunLogWriter(logDir, runId);
			const baseEnv = invocationEnv ?? runEnv;
			const propagationCarrier: Record<string, string> = {};
			propagation.inject(otelContext.active(), propagationCarrier);
			const resolvedEnv = {
				...baseEnv,
				...(propagationCarrier["traceparent"] && {
					TRACEPARENT: propagationCarrier["traceparent"],
				}),
				...(propagationCarrier["tracestate"] && {
					TRACESTATE: propagationCarrier["tracestate"],
				}),
			};
			return instrumentedQuery({
				prompt,
				options: {
					cwd,
					model,
					env: resolvedEnv,
					abortController: abortControllerFromSignal(signal),
					allowedTools: [...(allowedTools ?? DEFAULT_ALLOWED_TOOLS)],
					permissionMode: "dontAsk" as const,
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
					hooks: buildAgentHooks(runLogWriter, onToolFailure),
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
