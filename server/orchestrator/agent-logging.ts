import * as canonicalLog from "../canonical-log.ts";
import type { RunContext } from "../runner/runner.ts";

type AgentMessage = {
	type: "assistant";
	message: { content: ContentBlock[] };
};

type EmitContext = {
	ctx: Pick<RunContext, "emit">;
	stepName: string;
	cwd: string;
};

export function emitAgentMessageEvents(
	msg: AgentMessage,
	{ ctx, stepName, cwd }: EmitContext,
): void {
	for (const block of msg.message.content) {
		if (isTextBlock(block)) {
			const text = block.text.trim();
			if (text.length === 0) continue;
			ctx.emit({
				kind: "agent:say",
				stepName,
				data: { text },
			});
			continue;
		}
		if (!isToolUseBlock(block)) continue;
		canonicalLog.incrementMap("tool_use_by_name", block.name);
		emitToolEvent(block, { ctx, stepName, cwd });
	}
}

type TextBlock = { type: "text"; text: string };
type ToolUseBlock = {
	type: "tool_use";
	id?: string;
	name: string;
	input: Record<string, unknown>;
};
type ContentBlock = TextBlock | ToolUseBlock | { type: string };

function isTextBlock(block: ContentBlock): block is TextBlock {
	return block.type === "text" && typeof (block as TextBlock).text === "string";
}

function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
	return block.type === "tool_use";
}

function emitToolEvent(
	block: ToolUseBlock,
	{ ctx, stepName, cwd }: EmitContext,
): void {
	const input = block.input;
	switch (block.name) {
		case "Read": {
			ctx.emit({
				kind: "tool:read",
				stepName,
				data: {
					path: shortPath(stringInput(input["file_path"]), cwd),
					lines: 0,
				},
			});
			return;
		}
		case "Edit":
		case "Write":
		case "MultiEdit": {
			ctx.emit({
				kind: "tool:edit",
				stepName,
				data: {
					path: shortPath(stringInput(input["file_path"]), cwd),
					added: 0,
					removed: 0,
					summary: "",
				},
			});
			return;
		}
		case "Grep": {
			ctx.emit({
				kind: "tool:grep",
				stepName,
				data: {
					pattern: stringInput(input["pattern"]),
					path: shortPath(stringInput(input["path"] ?? ""), cwd),
					matches: 0,
				},
			});
			return;
		}
		case "Bash": {
			ctx.emit({
				kind: "tool:bash",
				stepName,
				data: {
					command: shortenCommand(stringInput(input["command"]), cwd),
					cwd,
					state: "running",
					exitCode: null,
				},
			});
			return;
		}
		case "Skill": {
			ctx.emit({
				kind: "tool:other",
				stepName,
				data: {
					tool: "Skill",
					summary: stringInput(input["skill"]).slice(0, 100),
				},
			});
			return;
		}
		case "StructuredOutput":
			return;
		default: {
			const summary = stringInput(
				input["description"] ??
					input["pattern"] ??
					input["query"] ??
					input["url"] ??
					input["file_path"] ??
					input["command"] ??
					"",
			);
			ctx.emit({
				kind: "tool:other",
				stepName,
				data: {
					tool: block.name,
					summary: shortPath(summary, cwd).slice(0, 100),
				},
			});
		}
	}
}

function stringInput(value: unknown): string {
	if (value == null) return "";
	return String(value);
}

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

function shortenCommand(command: string, workDir: string): string {
	if (workDir === "") return command;
	return command
		.split(`/private${workDir}/`)
		.join("")
		.split(`${workDir}/`)
		.join("");
}
