import type { query } from "@anthropic-ai/claude-agent-sdk";
import * as Tracer from "@effect/opentelemetry/Tracer";
import {
	context as otelContext,
	trace as otelTrace,
	propagation,
} from "@opentelemetry/api";
import { Effect, Option, type Scope } from "effect";
import { instrumentedQuery } from "../telemetry.ts";
import type { RunId } from "../types/brands.ts";
import { buildAgentHooks } from "./agent-hooks.ts";
import { makeRunLogWriter } from "./run-log-file.ts";

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

export interface AgentInvokerService {
	readonly invoke: (
		opts: AgentInvokeOptions,
	) => Effect.Effect<AsyncIterable<AgentMessage>, never, Scope.Scope>;
}

export type AgentInvokerLiveParams = {
	env: Record<string, string>;
	logDir: string;
	cwd: string;
	runId: RunId;
};

export class AgentInvoker extends Effect.Service<AgentInvoker>()(
	"AgentInvoker",
	{
		effect: ({ env: runEnv, logDir, cwd, runId }: AgentInvokerLiveParams) =>
			Effect.gen(function* () {
				const runLogWriter = yield* makeRunLogWriter(logDir, runId);
				const runtime = yield* Effect.runtime<never>();
				const hooks = buildAgentHooks(runtime, runLogWriter);

				const service: AgentInvokerService = {
					invoke({
						prompt,
						model,
						env: invocationEnv,
						resumeSessionId,
						outputFormat,
						allowedTools,
						onToolFailure,
					}) {
						return Effect.gen(function* () {
							const baseEnv = invocationEnv ?? runEnv;
							const resolvedEnv = {
								...baseEnv,
								...(yield* propagationEnv),
							};

							const controller = new AbortController();
							yield* Effect.addFinalizer(() =>
								Effect.sync(() => {
									if (!controller.signal.aborted) controller.abort();
								}),
							);

							const invokeHooks = onToolFailure
								? buildAgentHooks(runtime, runLogWriter, onToolFailure)
								: hooks;

							return instrumentedQuery({
								prompt,
								options: {
									cwd,
									model,
									env: resolvedEnv,
									abortController: controller,
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
						});
					},
				};
				return service;
			}),
	},
) {}

const DEFAULT_ALLOWED_TOOLS = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Glob",
	"Grep",
	"Agent",
] as const;

// Build a `TRACEPARENT`/`TRACESTATE` env carrier from the Effect-managed OTel
// span so the SDK subprocess joins the same trace. Reads the span via
// `Tracer.currentOtelSpan` (rather than `otelContext.active()`) so the source
// of truth is unambiguous — we forward exactly the span Effect is tracking.
const propagationEnv: Effect.Effect<Record<string, string>> =
	Tracer.currentOtelSpan.pipe(
		Effect.option,
		Effect.map((maybeSpan) => {
			if (Option.isNone(maybeSpan)) return {};
			const ctx = otelTrace.setSpan(otelContext.active(), maybeSpan.value);
			const carrier: Record<string, string> = {};
			propagation.inject(ctx, carrier);
			const out: Record<string, string> = {};
			if (carrier["traceparent"]) out["TRACEPARENT"] = carrier["traceparent"];
			if (carrier["tracestate"]) out["TRACESTATE"] = carrier["tracestate"];
			return out;
		}),
	);
