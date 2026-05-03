import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type RepoSlug, repoSlug } from "./types/brands.ts";

export type Config = {
	tracker:
		| {
				kind: "github";
		  }
		| {
				kind: "jira";
				base_url: string;
				project: string;
				statuses: {
					pending: string;
					running: string;
					awaiting_review: string;
				};
		  };
	code_host:
		| {
				kind: "github";
				scopes: RepoSlug[];
		  }
		| {
				kind: "gitlab";
				scopes: RepoSlug[];
				base_url: string;
		  };
	defaults: {
		polling_interval_ms: number;
		max_concurrent: number;
		max_retries: number;
		model: string;
		workspace_root: string;
	};
};

const repoSlugSchema = z.string().min(1).transform(repoSlug);

const configSchema = z
	.object({
		tracker: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("github"),
				})
				.strict(),
			z
				.object({
					kind: z.literal("jira"),
					base_url: z.url(),
					project: z.string().min(1),
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
					kind: z.literal("github"),
					scopes: z.array(repoSlugSchema).min(1),
				})
				.strict(),
			z
				.object({
					kind: z.literal("gitlab"),
					scopes: z.array(repoSlugSchema).min(1),
					base_url: z.url(),
				})
				.strict(),
		]),
		defaults: z
			.object({
				polling_interval_ms: z.number().int().positive(),
				max_concurrent: z.number().int().positive(),
				max_retries: z.number().int().nonnegative(),
				model: z.string().min(1),
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
