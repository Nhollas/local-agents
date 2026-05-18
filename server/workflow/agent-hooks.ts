import type {
	HookCallback,
	HookCallbackMatcher,
	HookEvent,
	HookInput,
	SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import * as canonicalLog from "../canonical-log.ts";
import type { RunLogWriter } from "./run-log-file.ts";

export const BASH_TIMEOUT_CAP_MS = 180_000;

const BASH_TOOL_NAME = "Bash";

// Any push is owned by the orchestrator, not the agent.
const PUSH_PATTERN = "git push";

// Destructive operations that can lose work.
const DESTRUCTIVE_GIT_PATTERNS = [
	"git reset --hard",
	"git clean -f",
	"git clean -fd",
	"git clean -fdx",
	"git checkout -- .",
	"git checkout .",
	"git restore .",
	"git branch -D",
	"git stash drop",
	"git stash clear",
] as const;

const COMMIT_TYPES = [
	"feat",
	"fix",
	"chore",
	"docs",
	"refactor",
	"test",
	"ci",
	"perf",
	"build",
	"style",
	"revert",
] as const;

const CONVENTIONAL_COMMIT_PATTERN = new RegExp(
	`^(${COMMIT_TYPES.join("|")})(\\([a-zA-Z0-9._-]+\\))?!?: .+`,
);

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
		// Ordering matters: blockDangerousGit and validateCommitMessage inspect
		// the original tool_input.command; capBashTimeout rewrites it. Run
		// inspectors first so they see the unwrapped command.
		PreToolUse: [
			{
				matcher: BASH_TOOL_NAME,
				hooks: [
					safePolicy(blockDangerousGit),
					safePolicy(validateCommitMessage),
					safePolicy(capBashTimeout),
				],
			},
		],
		PostToolUse: [{ hooks: postToolUse }],
		PostToolUseFailure: [{ hooks: postToolUseFailure }],
	};
}

export function blockDangerousGit(input: HookInput): SyncHookJSONOutput {
	const invocation = readBashInvocation(input);
	if (invocation === null) return {};
	const { command } = invocation;
	if (command.includes(PUSH_PATTERN)) return denyBash("push", command);
	for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
		if (command.includes(pattern)) {
			return denyBash("destructive git operation", command);
		}
	}
	return {};
}

export function validateCommitMessage(input: HookInput): SyncHookJSONOutput {
	const invocation = readBashInvocation(input);
	if (invocation === null) return {};
	const { command: cmd } = invocation;
	if (!(cmd.includes("git commit") && cmd.includes("-m"))) return {};
	// --amend may reuse the previous message; let it through.
	if (cmd.includes("--amend")) return {};
	const firstLine = extractCommitFirstLine(cmd);
	// Could not extract (editor commit, -F, unusual quoting) — let it through.
	if (firstLine === null) return {};
	if (CONVENTIONAL_COMMIT_PATTERN.test(firstLine)) return {};
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: [
				"BLOCKED: Commit message does not follow Conventional Commits format.",
				"",
				`  Got: "${firstLine}"`,
				"",
				"Expected: <type>(<optional scope>): <description>",
				`Types: ${COMMIT_TYPES.join(", ")}`,
				"Examples:",
				"  feat: add user authentication",
				"  fix(api): handle null response body",
				"  docs: update README with setup instructions",
			].join("\n"),
		},
	};
}

// The SDK's Bash tool only SIGKILLs the immediate child shell on timeout, so
// grandchildren (vitest workers, npm subprocesses) can survive and pin the
// tool call open indefinitely. Rewrite the command to run the inner work in
// its own process group via `set -m` and SIGKILL `-$pid` (the whole group)
// from a sibling watchdog. Exit 124 mirrors `timeout(1)`'s convention so the
// agent gets a recognisable timeout signal alongside the stderr explanation.
export function capBashTimeout(input: HookInput): SyncHookJSONOutput {
	const invocation = readBashInvocation(input);
	if (invocation === null) return {};
	const { command, toolInput } = invocation;
	const requested =
		typeof toolInput["timeout"] === "number" ? toolInput["timeout"] : undefined;
	const timeoutMs =
		requested === undefined || requested > BASH_TIMEOUT_CAP_MS
			? BASH_TIMEOUT_CAP_MS
			: requested;
	// Round up so a 1500ms request still gets a >=2s watchdog.
	const timeoutS = Math.ceil(timeoutMs / 1000);
	// Base64-encode the agent's command so we never have to escape arbitrary
	// shell into the wrapper. The base64 alphabet is shell-safe.
	const commandB64 = Buffer.from(command, "utf8").toString("base64");
	// `bash -c` explicitly because the SDK may select zsh as the persistent
	// shell, and `set -m` is rejected in non-interactive zsh.
	const inner = [
		"set -m",
		`eval "$(echo ${commandB64} | base64 -d)" &`,
		"pid=$!",
		"(",
		`  sleep ${timeoutS}`,
		`  echo "[cap-bash-timeout] killed pgroup after ${timeoutS}s (limit=${timeoutMs}ms, cap=${BASH_TIMEOUT_CAP_MS}ms) -- enforced by agent-hooks.ts because the SDK only SIGKILLs the immediate shell. Check for leaked file/socket/worker handles, watch processes, or unawaited backgrounded subshells in the command." >&2`,
		"  kill -KILL -$pid 2>/dev/null",
		") &",
		"wpid=$!",
		"wait $pid",
		"rc=$?",
		"if ! kill -0 $wpid 2>/dev/null; then",
		"  rc=124",
		"else",
		"  kill $wpid 2>/dev/null",
		"fi",
		"exit $rc",
	].join("\n");
	const innerB64 = Buffer.from(inner, "utf8").toString("base64");
	const wrapped = `bash -c "$(echo ${innerB64} | base64 -d)"`;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			updatedInput: { ...toolInput, command: wrapped, timeout: timeoutMs },
		},
	};
}

type BashInvocation = {
	command: string;
	toolInput: Record<string, unknown>;
};

function readBashInvocation(input: HookInput): BashInvocation | null {
	if (input.hook_event_name !== "PreToolUse") return null;
	if (input.tool_name !== BASH_TOOL_NAME) return null;
	const toolInput = input.tool_input;
	if (typeof toolInput !== "object" || toolInput === null) return null;
	const record = toolInput as Record<string, unknown>;
	const command = record["command"];
	if (typeof command !== "string" || command.length === 0) return null;
	return { command, toolInput: record };
}

function denyBash(kind: string, command: string): SyncHookJSONOutput {
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "deny",
			permissionDecisionReason: [
				`BLOCKED (${kind}): "${command}"`,
				"",
				"This command is reserved for the HITL or is destructive in a way that loses work.",
				"Do the actual work (edit, commit) and stop.",
			].join("\n"),
		},
	};
}

function extractCommitFirstLine(command: string): string | null {
	const heredocOpener = command.match(
		/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/,
	);
	if (heredocOpener && heredocOpener.index !== undefined) {
		const tag = heredocOpener[1];
		const closer = new RegExp(`^\\s*${tag}\\s*$`);
		const lines = command
			.slice(heredocOpener.index + heredocOpener[0].length)
			.split("\n");
		// Skip the partial line where the heredoc opens; scan the next ones.
		for (const line of lines.slice(1)) {
			if (closer.test(line)) return null;
			if (line.trim().length === 0) continue;
			return line.replace(/^\s+/, "");
		}
		return null;
	}
	const dq = command.match(/-m\s+"([^"]*)"/);
	if (dq?.[1] !== undefined) return dq[1];
	const sq = command.match(/-m\s+'([^']*)'/);
	if (sq?.[1] !== undefined) return sq[1];
	return null;
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

// Wrap a side-effecting hook so a thrown error never blocks the agent.
function safe(fn: (input: HookInput) => void | Promise<void>): HookCallback {
	return async (input) => {
		try {
			await fn(input);
		} catch (err) {
			logHookError(input, err);
		}
		return {};
	};
}

// Wrap a policy hook so a thrown error fails open ({}) rather than blocking.
function safePolicy(
	fn: (input: HookInput) => SyncHookJSONOutput | Promise<SyncHookJSONOutput>,
): HookCallback {
	return async (input) => {
		try {
			return await fn(input);
		} catch (err) {
			logHookError(input, err);
			return {};
		}
	};
}

function logHookError(input: HookInput, err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.warn(`agent hook (${input.hook_event_name}) failed: ${message}`);
}
