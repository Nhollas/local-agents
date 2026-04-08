/**
 * Shared agent message logging utilities.
 */
import { logger } from "../logger.ts";

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
	type: "tool_use";
	name: string;
	input: Record<string, unknown>;
};
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

export type AgentMessage = {
	type: "assistant";
	message: { content: ContentBlock[] };
};

function isToolUse(block: ContentBlock): block is ToolUseBlock {
	return block.type === "tool_use";
}

/** Strip the workdir prefix from a path for cleaner logging. */
function shortPath(fullPath: string, workDir: string): string {
	const privatePrefixed = `/private${workDir}`;
	if (fullPath.startsWith(privatePrefixed)) {
		return fullPath.slice(privatePrefixed.length + 1);
	}
	if (fullPath.startsWith(workDir)) {
		return fullPath.slice(workDir.length + 1);
	}
	return fullPath;
}

/** Log assistant text and tool use activity from an agent message. */
export function logAgentMessage(
	msg: AgentMessage,
	workDir: string,
	emitToolUse?: (tool: string, target: string) => void,
): void {
	const text = msg.message.content
		.filter((b): b is TextBlock => b.type === "text")
		.map((b) => b.text)
		.join("")
		.slice(0, 200);
	if (text) logger.debug({ text }, "agent.text");

	for (const block of msg.message.content) {
		if (!isToolUse(block)) continue;
		const raw = String(
			block.input["pattern"] ??
				block.input["file_path"] ??
				block.input["command"] ??
				"",
		);
		const detail = shortPath(raw, workDir).slice(0, 100);
		logger.debug({ tool: block.name, target: detail }, "agent.tool_use");
		emitToolUse?.(block.name, detail);
	}
}
