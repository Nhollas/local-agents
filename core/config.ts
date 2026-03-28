import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import type { Config } from "./types.ts";

const configSchema = z.object({
	tracker: z.object({
		kind: z.literal("github"),
	}),
	code_host: z.object({
		kind: z.literal("github"),
	}),
	repos: z.array(z.string()).min(1),
	defaults: z
		.object({
			polling_interval_ms: z.number().default(30000),
			max_concurrent: z.number().default(2),
			max_retries: z.number().default(3),
			model: z.string().default("claude-sonnet-4-6"),
			workspace_root: z.string().default("/tmp/local-agent-workspaces"),
		})
		.optional()
		.transform(
			(v) =>
				v ?? {
					polling_interval_ms: 30000,
					max_concurrent: 2,
					max_retries: 3,
					model: "claude-sonnet-4-6",
					workspace_root: "/tmp/local-agent-workspaces",
				},
		),
});

export function loadConfig(filePath: string): Config {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = parse(raw);
	return configSchema.parse(parsed);
}
