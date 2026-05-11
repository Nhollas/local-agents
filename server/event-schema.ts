import { z } from "zod";
import { runIdSchema } from "./types/brands.ts";

export const toolBashDataSchema = z.object({
	command: z.string(),
	cwd: z.string().nullable(),
	state: z.enum(["running", "exited", "aborted"]),
	exitCode: z.number().nullable(),
});
export type ToolBashData = z.infer<typeof toolBashDataSchema>;

const eventBaseSchema = z.object({
	id: z.string(),
	seq: z.number(),
	runId: runIdSchema,
	stepName: z.string().nullable(),
	createdAt: z.string(),
});

export const runEventSchema = z.discriminatedUnion("kind", [
	eventBaseSchema.extend({
		kind: z.literal("run:started"),
		data: z.object({
			issueKey: z.string().nullable(),
			issueTitle: z.string().nullable(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("run:completed"),
		data: z.object({
			durationMs: z.number(),
			costUsd: z.number(),
			tokens: z.object({ in: z.number(), out: z.number() }),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("run:failed"),
		data: z.object({ error: z.string(), durationMs: z.number() }),
	}),
	eventBaseSchema.extend({
		kind: z.literal("step:started"),
		data: z.object({
			name: z.string(),
			index: z.number(),
			total: z.number(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("step:completed"),
		data: z.object({
			name: z.string(),
			index: z.number(),
			durationMs: z.number(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("step:failed"),
		data: z.object({
			name: z.string(),
			index: z.number(),
			error: z.string(),
			durationMs: z.number(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("agent:say"),
		data: z.object({ text: z.string() }),
	}),
	eventBaseSchema.extend({
		kind: z.literal("tool:read"),
		data: z.object({ path: z.string(), lines: z.number() }),
	}),
	eventBaseSchema.extend({
		kind: z.literal("tool:edit"),
		data: z.object({
			path: z.string(),
			added: z.number(),
			removed: z.number(),
			summary: z.string(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("tool:grep"),
		data: z.object({
			pattern: z.string(),
			path: z.string(),
			matches: z.number(),
		}),
	}),
	eventBaseSchema.extend({
		kind: z.literal("tool:bash"),
		data: toolBashDataSchema,
	}),
	eventBaseSchema.extend({
		kind: z.literal("tool:other"),
		data: z.object({ tool: z.string(), summary: z.string() }),
	}),
	eventBaseSchema.extend({
		kind: z.literal("system"),
		data: z.object({
			message: z.string(),
			command: z.string().nullable(),
			path: z.string().nullable(),
			exitCode: z.number().nullable(),
		}),
	}),
]);

export type RunEvent = z.infer<typeof runEventSchema>;
export type RunEventKind = RunEvent["kind"];
export type RunEventData = RunEvent["data"];

export const RUN_EVENT_KINDS: readonly RunEventKind[] =
	runEventSchema.options.map((o) => o.shape.kind.value);

export const LIFECYCLE_EVENT_KINDS = [
	"run:started",
	"run:completed",
	"run:failed",
	"step:started",
	"step:completed",
	"step:failed",
] as const satisfies readonly RunEventKind[];

export const RUN_TERMINAL_EVENT_KINDS = [
	"run:completed",
	"run:failed",
] as const satisfies readonly RunEventKind[];
