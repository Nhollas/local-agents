import "dotenv/config";
import { z } from "zod";

const logLevelSchema = z.enum([
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
]);

const envSchema = z.object({
	CONFIG_PATH: z.string().min(1),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: logLevelSchema.default("info"),
	GITLAB_TOKEN: z.string().optional(),
	GITHUB_TOKEN: z.string().optional(),
	JIRA_EMAIL: z.string().optional(),
	JIRA_API_TOKEN: z.string().optional(),
	LANGFUSE_PUBLIC_KEY: z.string().min(1),
	LANGFUSE_SECRET_KEY: z.string().min(1),
	LANGFUSE_HOST: z.url().default("http://localhost:3100"),
	LANGFUSE_BASE_URL: z.url().default("http://localhost:3000"),
	LANGFUSE_PROJECT_ID: z.string().default(""),
});

type Env = z.infer<typeof envSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export const env = parseEnv();

function parseEnv(): Env {
	const result = envSchema.safeParse(process.env);
	if (!result.success) {
		const issues = result.error.issues
			.map((i) => `  ${i.path.join(".")}: ${i.message}`)
			.join("\n");
		console.error(`Invalid environment variables:\n${issues}`);
		process.exit(1);
	}
	return result.data;
}
