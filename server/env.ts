import "dotenv/config";
import { z } from "zod";
import type { Config } from "./config.ts";
import {
	type GitHubToken,
	type GitLabToken,
	githubToken,
	gitlabToken,
	type JiraApiToken,
	type JiraEmail,
	jiraApiToken,
	jiraEmail,
} from "./types/brands.ts";

const envSchema = z.object({
	CONFIG_PATH: z.string().min(1),
	PORT: z.coerce.number().default(3000),
	LOG_LEVEL: z.string().default("info"),
	GITLAB_TOKEN: z.string().optional(),
	GITHUB_TOKEN: z.string().optional(),
	JIRA_EMAIL: z.string().optional(),
	JIRA_API_TOKEN: z.string().optional(),
});

type RawEnv = z.infer<typeof envSchema>;

type Env = Omit<
	RawEnv,
	"GITLAB_TOKEN" | "GITHUB_TOKEN" | "JIRA_EMAIL" | "JIRA_API_TOKEN"
> & {
	GITLAB_TOKEN?: GitLabToken;
	GITHUB_TOKEN?: GitHubToken;
	JIRA_EMAIL?: JiraEmail;
	JIRA_API_TOKEN?: JiraApiToken;
};

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

	return brandEnv(env);
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

function requireToken(env: RawEnv, name: keyof RawEnv) {
	if (typeof env[name] !== "string" || env[name].length === 0) {
		console.error(
			`Invalid environment variables:\n  ${name}: ${name} is required`,
		);
		process.exit(1);
	}
}

function brandEnv(env: RawEnv): Env {
	const { GITLAB_TOKEN, GITHUB_TOKEN, JIRA_EMAIL, JIRA_API_TOKEN, ...rest } =
		env;
	return {
		...rest,
		...(GITLAB_TOKEN != null && { GITLAB_TOKEN: gitlabToken(GITLAB_TOKEN) }),
		...(GITHUB_TOKEN != null && { GITHUB_TOKEN: githubToken(GITHUB_TOKEN) }),
		...(JIRA_EMAIL != null && { JIRA_EMAIL: jiraEmail(JIRA_EMAIL) }),
		...(JIRA_API_TOKEN != null && {
			JIRA_API_TOKEN: jiraApiToken(JIRA_API_TOKEN),
		}),
	};
}
