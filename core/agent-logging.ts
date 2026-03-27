/**
 * Shared agent message logging utilities.
 */
import { logger } from "./logger.ts";

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
  msg: { type: string; message: { content: Array<Record<string, unknown>> } },
  workDir: string,
  emitToolUse?: (tool: string, target: string) => void,
): void {
  const text = msg.message.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")
    .slice(0, 200);
  if (text) logger.debug({ text: text.slice(0, 200) }, "agent.text");

  const toolUses = msg.message.content.filter(
    (b) => b.type === "tool_use"
  ) as Array<{ type: "tool_use"; name: string; input: Record<string, unknown> }>;
  for (const tool of toolUses) {
    const raw = String(tool.input.pattern ?? tool.input.file_path ?? tool.input.command ?? "");
    const detail = shortPath(raw, workDir);
    logger.debug({ tool: tool.name, target: detail.slice(0, 100) }, "agent.tool_use");
    emitToolUse?.(tool.name, detail.slice(0, 100));
  }
}
