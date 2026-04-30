import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
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
				repos: string[];
		  }
		| {
				kind: "gitlab";
				repos: string[];
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
					base_url: z.string().url(),
					project: z.string().min(1),
					statuses: z
						.object({
							pending: z.string().default("To Do"),
							running: z.string().default("In Progress"),
							awaiting_review: z.string().default("In Review"),
						})
						.strict()
						.default({
							pending: "To Do",
							running: "In Progress",
							awaiting_review: "In Review",
						}),
				})
				.strict(),
		]),
		code_host: z.discriminatedUnion("kind", [
			z
				.object({
					kind: z.literal("github"),
					repos: z.array(z.string()).min(1),
				})
				.strict(),
			z
				.object({
					kind: z.literal("gitlab"),
					repos: z.array(z.string()).min(1),
					base_url: z.string().url().default("https://gitlab.com"),
				})
				.strict(),
		]),
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
	})
	.strict()
	.superRefine((config, ctx) => {
		if (config.tracker.kind === "jira" && config.code_host.repos.length !== 1) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["code_host", "repos"],
				message: "Jira tracker requires exactly one code_host.repos entry",
			});
		}
	});

export function loadConfig(filePath: string): Config {
	const raw = readFileSync(filePath, "utf-8");
	const parsed = parse(raw);
	return configSchema.parse(parsed);
}
