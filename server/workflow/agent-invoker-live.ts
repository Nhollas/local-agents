import type { FileSystem } from "@effect/platform";
import { context as otelContext, propagation } from "@opentelemetry/api";
import { Effect } from "effect";
import { instrumentedQuery } from "../telemetry.ts";
import type { RunId } from "../types/brands.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import {
	type AgentInvokerService,
	DEFAULT_ALLOWED_TOOLS,
} from "./agent-invoker.ts";
import { makeRunLogWriter } from "./run-log-file.ts";

export type AgentInvokerLiveParams = {
	env: Record<string, string>;
	logDir: string;
	cwd: string;
	runId: RunId;
	signal: AbortSignal;
};

export const makeClaudeSdkAgentInvoker = ({
	env: runEnv,
	logDir,
	cwd,
	runId,
	signal,
}: AgentInvokerLiveParams): Effect.Effect<
	AgentInvokerService,
	never,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const runLogWriter = yield* makeRunLogWriter(logDir, runId);
		const runtime = yield* Effect.runtime<never>();
		const hooks = buildAgentHooks(runtime, runLogWriter);

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
				const invokeHooks = onToolFailure
					? buildAgentHooks(runtime, runLogWriter, onToolFailure)
					: hooks;
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
						hooks: invokeHooks,
						...(resumeSessionId && { resume: resumeSessionId }),
						...(outputFormat && { outputFormat }),
					},
				});
			},
		};
	});

function abortControllerFromSignal(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort(signal.reason);
	else
		signal.addEventListener("abort", () => controller.abort(signal.reason), {
			once: true,
		});
	return controller;
}
