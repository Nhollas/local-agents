import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { repoSlugSchema } from "./types/brands.ts";

export type Config = z.infer<typeof configSchema>;

const configSchema = z
	.object({
		tracker: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("jira"),
					base_url: z.url(),
					project: z.string().min(1),
					trigger_label: z.string().min(1),
					statuses: z
						.object({
							pending: z.string().min(1),
							running: z.string().min(1),
							awaiting_review: z.string().min(1),
						})
						.strict(),
				})
				.strict(),
		]),
		code_host: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("gitlab"),
					scopes: z.array(repoSlugSchema).min(1),
					base_url: z.url(),
				})
				.strict(),
			z
				.object({
					kind: z.literal("github"),
					scopes: z.array(repoSlugSchema).min(1),
				})
				.strict(),
		]),
		defaults: z
			.object({
				polling_interval_ms: z.number().int().positive(),
				max_concurrent: z.number().int().positive(),
				workspace_root: z.string().min(1),
			})
			.strict(),
	})
	.strict();

export function loadConfig(filePath: string): Config {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = parse(raw);
	return configSchema.parse(parsed);
}
