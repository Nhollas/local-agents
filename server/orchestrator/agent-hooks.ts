import type {
	HookCallbackMatcher,
	HookEvent,
	HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import * as canonicalLog from "../canonical-log.ts";

export function buildCanonicalLogHooks(): Partial<
	Record<HookEvent, HookCallbackMatcher[]>
> {
	return {
		PostToolUse: [{ hooks: [safe(record)] }],
		PostToolUseFailure: [{ hooks: [safe(record)] }],
	};
}

function record(input: HookInput): void {
	if (input.hook_event_name === "PostToolUse") {
		addToolDuration(input.tool_name, input.duration_ms);
		return;
	}
	if (input.hook_event_name === "PostToolUseFailure") {
		canonicalLog.incrementMap("tool_failures_by_name", input.tool_name);
		// Fold failure wall-time into the same map as successes so the per-tool
		// total reflects all time spent in that tool, not just successful calls.
		addToolDuration(input.tool_name, input.duration_ms);
	}
}

function addToolDuration(toolName: string, durationMs: unknown): void {
	if (typeof durationMs !== "number" || durationMs <= 0) return;
	canonicalLog.incrementMap("tool_duration_ms_by_name", toolName, durationMs);
}

function safe(fn: (input: HookInput) => void) {
	return async (input: HookInput) => {
		try {
			fn(input);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(
				`canonical-log hook (${input.hook_event_name}) failed: ${message}`,
			);
		}
		return {};
	};
}
