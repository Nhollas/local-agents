import "dotenv/config";
import { z } from "zod";
import type { Config } from "./config.ts";

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

const envSchema = z.object({
	CONFIG_PATH: z.string().default("./config.yaml"),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.string().default("info"),
	GITHUB_TOKEN: z.string().optional(),
	GITLAB_TOKEN: z.string().optional(),
});

function requireToken(env: z.infer<typeof envSchema>, name: keyof typeof env) {
	if (typeof env[name] !== "string" || env[name].length === 0) {
		console.error(
			`Invalid environment variables:\n  ${name}: ${name} is required`,
		);
		process.exit(1);
	}
}

export function loadEnv(config?: Pick<Config, "tracker" | "code_host">) {
	const env = parseEnv(envSchema);

	if (
		config?.tracker.kind === "github" ||
		config?.code_host.kind === "github"
	) {
		requireToken(env, "GITHUB_TOKEN");
	}

	if (config?.code_host.kind === "gitlab") {
		requireToken(env, "GITLAB_TOKEN");
	}

	return env;
}
