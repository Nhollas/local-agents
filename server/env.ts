import "dotenv/config";
import { z } from "zod";
import type { Config } from "./config.ts";

const envSchema = z.object({
	CONFIG_PATH: z.string().min(1),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.string().default("info"),
	GITLAB_TOKEN: z.string().optional(),
	GITHUB_TOKEN: z.string().optional(),
	JIRA_EMAIL: z.string().optional(),
	JIRA_API_TOKEN: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;

export function loadEnv(config?: Pick<Config, "tracker" | "code_host">): Env {
	const env = parseEnv(envSchema);

	if (config?.code_host.kind === "gitlab") {
		requireToken(env, "GITLAB_TOKEN");
	}

	if (config?.code_host.kind === "github") {
		requireToken(env, "GITHUB_TOKEN");
	}

	if (config?.tracker.kind === "jira") {
		requireToken(env, "JIRA_EMAIL");
		requireToken(env, "JIRA_API_TOKEN");
	}

	return env;
}

function parseEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
	const result = schema.safeParse(process.env);

	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		console.error(`Invalid environment variables:\n${issues}`);
		process.exit(1);
	}

	return result.data;
}

function requireToken(env: Env, name: keyof Env) {
	if (typeof env[name] !== "string" || env[name].length === 0) {
		console.error(
			`Invalid environment variables:\n  ${name}: ${name} is required`,
		);
		process.exit(1);
	}
}
