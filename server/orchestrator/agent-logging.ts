import * as canonicalLog from "../canonical-log.ts";

export type AgentMessage = {
	type: "assistant";
	message: { content: ContentBlock[] };
};

/** Log assistant text and tool use activity from an agent message. */
export function logAgentMessage(
	msg: AgentMessage,
	workDir: string,
	emitToolUse?: (tool: string, target: string) => void,
): void {
	for (const block of msg.message.content) {
		if (!isToolUse(block)) continue;
		const raw = String(
			block.input["pattern"] ??
				block.input["file_path"] ??
				block.input["command"] ??
				"",
		);
		const detail = shortPath(raw, workDir).slice(0, 100);
		canonicalLog.incrementMap("tool_use_by_name", block.name);
		emitToolUse?.(block.name, detail);
	}
}

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
	type: "tool_use";
	name: string;
	input: Record<string, unknown>;
};
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

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
