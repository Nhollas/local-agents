import type {
	PreToolUseHookInput,
	PreToolUseHookSpecificOutput,
	SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
	BASH_TIMEOUT_CAP_MS,
	blockDangerousGit,
	capBashTimeout,
	validateCommitMessage,
} from "./agent-hooks.ts";

function hookInput(
	command: string,
	{ toolName = "Bash", timeout }: { toolName?: string; timeout?: number } = {},
): PreToolUseHookInput {
	return {
		hook_event_name: "PreToolUse",
		session_id: "test-session",
		transcript_path: "/tmp/transcript",
		cwd: "/tmp/ws",
		tool_use_id: "tool-1",
		tool_name: toolName,
		tool_input: timeout === undefined ? { command } : { command, timeout },
	};
}

function updatedInput(result: SyncHookJSONOutput): {
	command: string;
	timeout: number;
} {
	const out: PreToolUseHookSpecificOutput | undefined =
		result.hookSpecificOutput?.hookEventName === "PreToolUse"
			? result.hookSpecificOutput
			: undefined;
	const ui = out?.updatedInput;
	if (!ui) throw new Error("expected hookSpecificOutput.updatedInput");
	const command = ui["command"];
	const timeout = ui["timeout"];
	if (typeof command !== "string" || typeof timeout !== "number") {
		throw new Error(`unexpected updatedInput shape: ${JSON.stringify(ui)}`);
	}
	return { command, timeout };
}

describe("blockDangerousGit", () => {
	it("denies any command containing `git push`", () => {
		expect(blockDangerousGit(hookInput("git push origin main"))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringContaining("BLOCKED (push)"),
			},
		});
	});

	it("denies destructive git operations", () => {
		const cases = [
			"git reset --hard HEAD~1",
			"git clean -fd",
			"git checkout -- .",
			"git restore .",
			"git branch -D feature/x",
			"git stash drop",
			"git stash clear",
		];
		for (const command of cases) {
			expect(blockDangerousGit(hookInput(command))).toEqual({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: "deny",
					permissionDecisionReason: expect.stringContaining(
						"BLOCKED (destructive git operation)",
					),
				},
			});
		}
	});

	it("allows benign git and shell commands", () => {
		const cases = [
			"git status",
			"git commit -m 'fix: thing'",
			"git checkout main",
			"ls -la",
			"pnpm test",
		];
		for (const command of cases) {
			expect(blockDangerousGit(hookInput(command))).toEqual({});
		}
	});

	it("ignores non-Bash tool calls", () => {
		expect(
			blockDangerousGit(hookInput("git push", { toolName: "Read" })),
		).toEqual({});
	});
});

describe("validateCommitMessage", () => {
	it("allows a conventional commit with -m", () => {
		expect(
			validateCommitMessage(
				hookInput(`git commit -m "feat: add roadmap timeline"`),
			),
		).toEqual({});
	});

	it("allows a conventional commit with scope and breaking marker", () => {
		expect(
			validateCommitMessage(
				hookInput(`git commit -m "fix(api)!: drop legacy field"`),
			),
		).toEqual({});
	});

	it("allows a heredoc commit whose first non-blank line is conventional", () => {
		const command = [
			"git commit -m \"$(cat <<'EOF'",
			"feat: add user authentication",
			"",
			"Long body explanation.",
			"EOF",
			')"',
		].join("\n");
		expect(validateCommitMessage(hookInput(command))).toEqual({});
	});

	it("denies a non-conventional inline commit", () => {
		expect(
			validateCommitMessage(hookInput(`git commit -m "added a roadmap"`)),
		).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringContaining(
					"Conventional Commits",
				),
			},
		});
	});

	it("denies a non-conventional heredoc commit", () => {
		const command = [
			"git commit -m \"$(cat <<'EOF'",
			"added a roadmap",
			"EOF",
			')"',
		].join("\n");
		expect(validateCommitMessage(hookInput(command))).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "deny",
				permissionDecisionReason: expect.stringContaining(
					"Conventional Commits",
				),
			},
		});
	});

	it("allows --amend without re-validating", () => {
		expect(
			validateCommitMessage(hookInput(`git commit --amend -m "anything goes"`)),
		).toEqual({});
	});

	it("ignores non-commit shell commands", () => {
		expect(validateCommitMessage(hookInput("pnpm test"))).toEqual({});
	});

	it("ignores commit invocations without -m (editor or -F)", () => {
		expect(validateCommitMessage(hookInput("git commit"))).toEqual({});
		expect(
			validateCommitMessage(hookInput("git commit -F message.txt")),
		).toEqual({});
	});
});

describe("capBashTimeout", () => {
	it("wraps the command in a pgroup watchdog and caps at the maximum timeout", () => {
		const result = capBashTimeout(hookInput("pnpm test"));
		expect(result).toEqual({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				updatedInput: {
					command: expect.stringMatching(
						/^bash -c "\$\(echo [A-Za-z0-9+/=]+ \| base64 -d\)"$/,
					),
					timeout: BASH_TIMEOUT_CAP_MS,
				},
			},
		});

		const { command } = updatedInput(result);
		const innerB64 = command.match(/echo (\S+) \|/)?.[1] ?? "";
		const inner = Buffer.from(innerB64, "base64").toString("utf8");
		expect(inner).toContain("set -m");
		expect(inner).toContain("kill -KILL -$pid");
		const commandB64 = inner.match(/echo (\S+) \| base64 -d/)?.[1] ?? "";
		expect(Buffer.from(commandB64, "base64").toString("utf8")).toBe(
			"pnpm test",
		);
	});

	it("preserves a requested timeout below the cap", () => {
		const result = capBashTimeout(hookInput("echo hi", { timeout: 5_000 }));
		expect(updatedInput(result).timeout).toBe(5_000);
	});

	it("clamps a requested timeout above the cap", () => {
		const result = capBashTimeout(hookInput("echo hi", { timeout: 999_999 }));
		expect(updatedInput(result).timeout).toBe(BASH_TIMEOUT_CAP_MS);
	});

	it("round-trips arbitrary shell metacharacters in the encoded payload", () => {
		const command = `echo "a' b\` $(c)" && rm -rf $TMPDIR/xyz`;
		const result = capBashTimeout(hookInput(command));
		const wrapped = updatedInput(result).command;
		const innerB64 = wrapped.match(/echo (\S+) \|/)?.[1] ?? "";
		const inner = Buffer.from(innerB64, "base64").toString("utf8");
		const commandB64 = inner.match(/echo (\S+) \| base64 -d/)?.[1] ?? "";
		expect(Buffer.from(commandB64, "base64").toString("utf8")).toBe(command);
	});

	it("ignores non-Bash tool calls", () => {
		expect(
			capBashTimeout(hookInput("pnpm test", { toolName: "Read" })),
		).toEqual({});
	});
});
