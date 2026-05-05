import { describe, expect, it, vi } from "vitest";
import * as canonicalLog from "../../canonical-log.ts";
import { type AgentMessage, logAgentMessage } from "../agent-logging.ts";

function capturingLogger(): {
	logger: { info(obj: Record<string, unknown>, msg: string): void };
	bag: () => Record<string, unknown>;
} {
	let captured: Record<string, unknown> = {};
	return {
		logger: {
			info(obj: Record<string, unknown>) {
				captured = obj;
			},
		},
		bag: () => captured,
	};
}

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

	it("aggregates a tool_use_by_name counter on the canonical bag", async () => {
		const { logger, bag } = capturingLogger();

		await canonicalLog.run(
			{ scope: "run" },
			async () => {
				logAgentMessage(toolUseMsg("Read", { file_path: "a.ts" }), "/work");
				logAgentMessage(toolUseMsg("Read", { file_path: "b.ts" }), "/work");
				logAgentMessage(toolUseMsg("Edit", { file_path: "c.ts" }), "/work");
			},
			logger,
		);

		expect(bag()).toEqual(
			expect.objectContaining({
				tool_use_by_name: { Read: 2, Edit: 1 },
			}),
		);
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
