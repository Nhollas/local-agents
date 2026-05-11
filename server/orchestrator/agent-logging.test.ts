import { describe, expect, it } from "vitest";
import * as canonicalLog from "../canonical-log.ts";
import type { RunEvent } from "../event-schema.ts";
import type { EmitInput, RunContext } from "../runner/runner.ts";
import {
	type AgentMessage,
	emitAgentMessageEvents,
	trackAgentToolUseBag,
} from "./agent-logging.ts";

function captureCtx(): {
	ctx: Pick<RunContext, "emit">;
	emitted: EmitInput[];
} {
	const emitted: EmitInput[] = [];
	const ctx: Pick<RunContext, "emit"> = {
		emit: ((input: EmitInput) => {
			emitted.push(input);
			return {} as RunEvent;
		}) as RunContext["emit"],
	};
	return { ctx, emitted };
}

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

describe("emitAgentMessageEvents", () => {
	it("emits agent:say for non-empty text blocks", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(textMsg("reading repo layout"), {
			ctx,
			stepName: "implement",
			cwd: "/work",
		});
		expect(emitted).toEqual([
			{
				kind: "agent:say",
				stepName: "implement",
				data: { text: "reading repo layout" },
			},
		]);
	});

	it("skips empty text blocks", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(textMsg("   "), {
			ctx,
			stepName: "implement",
			cwd: "/work",
		});
		expect(emitted).toEqual([]);
	});

	it("emits tool:read for Read with workdir-relative path", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(
			toolUseMsg("Read", { file_path: "/work/src/app.ts" }),
			{ ctx, stepName: "implement", cwd: "/work" },
		);
		expect(emitted).toEqual([
			{
				kind: "tool:read",
				stepName: "implement",
				data: { path: "src/app.ts", lines: 0 },
			},
		]);
	});

	it("emits tool:edit for Edit / Write / MultiEdit", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(toolUseMsg("Edit", { file_path: "/work/a.ts" }), {
			ctx,
			stepName: "implement",
			cwd: "/work",
		});
		emitAgentMessageEvents(toolUseMsg("Write", { file_path: "/work/b.ts" }), {
			ctx,
			stepName: "implement",
			cwd: "/work",
		});
		expect(emitted.map((e) => e.kind)).toEqual(["tool:edit", "tool:edit"]);
	});

	it("emits tool:grep with pattern and path", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(
			toolUseMsg("Grep", { pattern: "TODO", path: "/work/src" }),
			{ ctx, stepName: "implement", cwd: "/work" },
		);
		expect(emitted).toEqual([
			{
				kind: "tool:grep",
				stepName: "implement",
				data: { pattern: "TODO", path: "src", matches: 0 },
			},
		]);
	});

	it("emits tool:bash with state running and cwd populated", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(toolUseMsg("Bash", { command: "pnpm test" }), {
			ctx,
			stepName: "implement",
			cwd: "/work",
		});
		expect(emitted).toEqual([
			{
				kind: "tool:bash",
				stepName: "implement",
				data: {
					command: "pnpm test",
					cwd: "/work",
					state: "running",
					exitCode: null,
				},
			},
		]);
	});

	it("emits tool:other for unrecognised tools, summarising via known input fields", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(
			toolUseMsg("WebSearch", { query: "vitest coverage" }),
			{ ctx, stepName: "implement", cwd: "/work" },
		);
		expect(emitted).toEqual([
			{
				kind: "tool:other",
				stepName: "implement",
				data: { tool: "WebSearch", summary: "vitest coverage" },
			},
		]);
	});

	it("uses the Agent tool's description as its tool:other summary", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(
			toolUseMsg("Agent", {
				description: "find duplicate detection sites",
				prompt: "long prompt body that should not surface in the transcript",
				subagent_type: "general-purpose",
			}),
			{ ctx, stepName: "implement", cwd: "/work" },
		);
		expect(emitted).toEqual([
			{
				kind: "tool:other",
				stepName: "implement",
				data: { tool: "Agent", summary: "find duplicate detection sites" },
			},
		]);
	});

	it("does not emit a transcript event for StructuredOutput", () => {
		const { ctx, emitted } = captureCtx();
		emitAgentMessageEvents(
			toolUseMsg("StructuredOutput", { value: { title: "summary" } }),
			{ ctx, stepName: "summarise", cwd: "/work" },
		);
		expect(emitted).toEqual([]);
	});

	it("aggregates a tool_use_by_name counter on the canonical bag", async () => {
		const { ctx } = captureCtx();
		const { logger, bag } = capturingLogger();

		await canonicalLog.run(
			{ scope: "run" },
			async () => {
				emitAgentMessageEvents(toolUseMsg("Read", { file_path: "a.ts" }), {
					ctx,
					stepName: "implement",
					cwd: "/work",
				});
				emitAgentMessageEvents(toolUseMsg("Read", { file_path: "b.ts" }), {
					ctx,
					stepName: "implement",
					cwd: "/work",
				});
				emitAgentMessageEvents(toolUseMsg("Edit", { file_path: "c.ts" }), {
					ctx,
					stepName: "implement",
					cwd: "/work",
				});
			},
			logger,
		);

		expect(bag()).toEqual(
			expect.objectContaining({
				tool_use_by_name: { Read: 2, Edit: 1 },
			}),
		);
	});
});

describe("trackAgentToolUseBag", () => {
	it("increments tool counters without emitting events", async () => {
		const { logger, bag } = capturingLogger();
		await canonicalLog.run(
			{ scope: "run" },
			async () => {
				trackAgentToolUseBag(toolUseMsg("Bash", { command: "ls" }));
				trackAgentToolUseBag(toolUseMsg("Bash", { command: "pwd" }));
			},
			logger,
		);
		expect(bag()).toEqual(
			expect.objectContaining({ tool_use_by_name: { Bash: 2 } }),
		);
	});
});
