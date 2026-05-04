import { describe, expect, it, vi } from "vitest";
import { type AgentMessage, logAgentMessage } from "../agent-logging.ts";

function toolUseMsg(
	name: string,
	input: Record<string, unknown>,
): AgentMessage {
	return {
		type: "assistant",
		message: { content: [{ type: "tool_use", name, input }] },
	};
}

function textMsg(text: string): AgentMessage {
	return {
		type: "assistant",
		message: { content: [{ type: "text", text }] },
	};
}

describe("logAgentMessage", () => {
	it("does not call emitToolUse for text-only messages", () => {
		const longText = "a".repeat(300);
		const emitToolUse = vi.fn();

		logAgentMessage(textMsg(longText), "/workdir", emitToolUse);

		expect(emitToolUse).not.toHaveBeenCalled();
	});

	it("extracts tool_use and calls emitToolUse callback", () => {
		const emitToolUse = vi.fn();

		logAgentMessage(
			toolUseMsg("Bash", { command: "pnpm test" }),
			"/workdir",
			emitToolUse,
		);

		expect(emitToolUse).toHaveBeenCalledOnce();
		expect(emitToolUse).toHaveBeenCalledWith("Bash", "pnpm test");
	});

	it("emits empty detail for tools with no recognisable input keys", () => {
		const emitToolUse = vi.fn();

		logAgentMessage(
			toolUseMsg("WebSearch", { query: "vitest coverage" }),
			"/workdir",
			emitToolUse,
		);

		expect(emitToolUse).toHaveBeenCalledWith("WebSearch", "");
	});

	it("reads file_path, pattern, or command from tool input", () => {
		const emitToolUse = vi.fn();
		const workDir = "/workdir";

		logAgentMessage(
			toolUseMsg("Read", { file_path: "/workdir/src/app.ts" }),
			workDir,
			emitToolUse,
		);
		expect(emitToolUse).toHaveBeenLastCalledWith("Read", "src/app.ts");

		logAgentMessage(
			toolUseMsg("Grep", { pattern: "TODO" }),
			workDir,
			emitToolUse,
		);
		expect(emitToolUse).toHaveBeenLastCalledWith("Grep", "TODO");

		logAgentMessage(
			toolUseMsg("Bash", { command: "ls -la" }),
			workDir,
			emitToolUse,
		);
		expect(emitToolUse).toHaveBeenLastCalledWith("Bash", "ls -la");
	});
});
