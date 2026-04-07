import { describe, expect, it, vi } from "vitest";
import { logAgentMessage } from "./agent-logging.ts";

function toolUseMsg(name: string, input: Record<string, unknown>) {
	return {
		type: "assistant" as const,
		message: {
			content: [{ type: "tool_use" as const, name, input }],
		},
	};
}

function textMsg(text: string) {
	return {
		type: "assistant" as const,
		message: {
			content: [{ type: "text" as const, text }],
		},
	};
}

describe("shortPath (via logAgentMessage)", () => {
	it("strips workdir prefix", () => {
		const emitToolUse = vi.fn();
		const workDir = "/home/user/project";

		logAgentMessage(
			toolUseMsg("Read", { file_path: "/home/user/project/src/index.ts" }),
			workDir,
			emitToolUse,
		);

		expect(emitToolUse).toHaveBeenCalledWith("Read", "src/index.ts");
	});

	it("strips /private macOS prefix", () => {
		const emitToolUse = vi.fn();
		const workDir = "/tmp/workspace";

		logAgentMessage(
			toolUseMsg("Read", {
				file_path: "/private/tmp/workspace/lib/utils.ts",
			}),
			workDir,
			emitToolUse,
		);

		expect(emitToolUse).toHaveBeenCalledWith("Read", "lib/utils.ts");
	});

	it("returns full path when no prefix matches", () => {
		const emitToolUse = vi.fn();
		const workDir = "/home/user/project";

		logAgentMessage(
			toolUseMsg("Read", { file_path: "/other/location/file.ts" }),
			workDir,
			emitToolUse,
		);

		expect(emitToolUse).toHaveBeenCalledWith("Read", "/other/location/file.ts");
	});
});

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
