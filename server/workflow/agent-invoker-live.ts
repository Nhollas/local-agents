import { context as otelContext, propagation } from "@opentelemetry/api";
import { Layer } from "effect";
import { instrumentedQuery } from "../telemetry/otel.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import {
	AgentInvoker,
	type AgentInvokerService,
	DEFAULT_ALLOWED_TOOLS,
} from "./agent-invoker.ts";
import { createRunLogWriter } from "./run-log-file.ts";

type LiveParams = {
	env: Record<string, string>;
	logDir: string;
};

export function claudeSdkAgentInvoker({
	env,
	logDir,
}: LiveParams): AgentInvokerService {
	return {
		invoke({
			prompt,
			cwd,
			model,
			runId,
			env: invocationEnv,
			resumeSessionId,
			outputFormat,
			signal,
			allowedTools,
			onToolFailure,
		}) {
			const runLogWriter = createRunLogWriter(logDir, runId);
			const baseEnv = invocationEnv ?? env;
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

/** @lintignore consumed once engine runs under a per-run runtime (slices 5/6) */
export const AgentInvokerLive = (
	params: LiveParams,
): Layer.Layer<AgentInvoker> =>
	Layer.succeed(AgentInvoker, claudeSdkAgentInvoker(params));

function abortControllerFromSignal(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	return controller;
}
