import type { Config } from "../config.ts";

type AgentEnvConfig = Config["agent"]["env"];

export function resolveAgentEnvironment(
	config: AgentEnvConfig,
	sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};

	for (const key of config.include) {
		const value = sourceEnv[key];
		if (value !== undefined) env[key] = value;
	}

	for (const [key, value] of Object.entries(config.set)) {
		env[key] = value;
	}

	return env;
}
