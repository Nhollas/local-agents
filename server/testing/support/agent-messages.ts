import type { AgentMessage } from "../../orchestrator/agent-invoker.ts";

export function buildAssistantMessage(opts: {
	uuid: string;
	sessionId?: string;
}): AgentMessage {
	return {
		type: "assistant",
		session_id: opts.sessionId ?? "sess",
		message: { content: [] },
		parent_tool_use_id: null,
		uuid: opts.uuid,
	} as unknown as AgentMessage;
}

export function buildSuccessResult(opts: {
	uuid: string;
	sessionId?: string;
	structuredOutput?: unknown;
	totalCostUsd?: number;
	modelUsage?: Record<string, unknown>;
}): AgentMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: false,
		num_turns: 1,
		result: "ok",
		stop_reason: "end_turn",
		total_cost_usd: opts.totalCostUsd ?? 0,
		usage: {} as never,
		modelUsage: opts.modelUsage ?? {},
		permission_denials: [],
		...(opts.structuredOutput !== undefined && {
			structured_output: opts.structuredOutput,
		}),
		uuid: opts.uuid,
		session_id: opts.sessionId ?? "sess",
	} as AgentMessage;
}

export function buildErrorResult(opts: {
	uuid: string;
	sessionId?: string;
	subtype: "error_max_structured_output_retries" | "error_max_turns";
	totalCostUsd?: number;
	modelUsage?: Record<string, unknown>;
}): AgentMessage {
	return {
		type: "result",
		subtype: opts.subtype,
		duration_ms: 1,
		duration_api_ms: 1,
		is_error: true,
		num_turns: 1,
		stop_reason: null,
		total_cost_usd: opts.totalCostUsd ?? 0,
		usage: {} as never,
		modelUsage: opts.modelUsage ?? {},
		permission_denials: [],
		errors: [],
		uuid: opts.uuid,
		session_id: opts.sessionId ?? "sess",
	} as AgentMessage;
}
