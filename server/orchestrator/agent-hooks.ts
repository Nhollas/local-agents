import type {
	HookCallback,
	HookCallbackMatcher,
	HookEvent,
	HookInput,
} from "@anthropic-ai/claude-agent-sdk";
import * as canonicalLog from "../canonical-log.ts";
import type { RunLogWriter } from "./run-log-file.ts";

export function buildAgentHooks(
	runLogWriter?: RunLogWriter,
	onToolFailure?: (toolName: string) => void,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const postToolUse: HookCallback[] = [safe(record)];
	const postToolUseFailure: HookCallback[] = [safe(record)];
	if (onToolFailure) {
		postToolUseFailure.push(
			safe((input) => {
				if (input.hook_event_name === "PostToolUseFailure") {
					onToolFailure(input.tool_name);
				}
			}),
		);
	}
	if (runLogWriter) {
		postToolUse.push(safe(writeRunLog(runLogWriter)));
		postToolUseFailure.push(safe(writeRunLog(runLogWriter)));
	}
	return {
		PostToolUse: [{ hooks: postToolUse }],
		PostToolUseFailure: [{ hooks: postToolUseFailure }],
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

function writeRunLog(writer: RunLogWriter) {
	return async (input: HookInput): Promise<void> => {
		const timestamp = new Date().toISOString();
		if (input.hook_event_name === "PostToolUse") {
			await writer.append({
				timestamp,
				toolName: input.tool_name,
				status: "ok",
				toolInput: input.tool_input,
				toolResponse: input.tool_response,
				...(typeof input.duration_ms === "number" && {
					durationMs: input.duration_ms,
				}),
			});
			return;
		}
		if (input.hook_event_name === "PostToolUseFailure") {
			await writer.append({
				timestamp,
				toolName: input.tool_name,
				status: "failed",
				toolInput: input.tool_input,
				error: input.error,
				...(typeof input.duration_ms === "number" && {
					durationMs: input.duration_ms,
				}),
			});
		}
	};
}

function addToolDuration(toolName: string, durationMs: unknown): void {
	if (typeof durationMs !== "number" || durationMs <= 0) return;
	canonicalLog.incrementMap("tool_duration_ms_by_name", toolName, durationMs);
}

function safe(fn: (input: HookInput) => void | Promise<void>): HookCallback {
	return async (input) => {
		try {
			await fn(input);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`agent hook (${input.hook_event_name}) failed: ${message}`);
		}
		return {};
	};
}
