import type { ConfigFile } from "../config/schema.ts";

type AgentEnvConfig = ConfigFile["agent"]["env"];

// Shell basics required for the Claude Agent SDK subprocess to function:
// HOME locates `~/.claude/` credentials, PATH resolves git/node/pnpm/fnm,
// and the rest are widely assumed by shell tooling. These are not sensitive,
// so they're always passed through; opt-in `include` is for secrets.
const ALWAYS_INCLUDED_ENV = [
	"HOME",
	"PATH",
	"SHELL",
	"USER",
	"LOGNAME",
	"LANG",
	"TZ",
] as const;

export function resolveAgentEnvironment(
	config: AgentEnvConfig,
	sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	const env: Record<string, string> = {};

	for (const key of ALWAYS_INCLUDED_ENV) {
		const value = sourceEnv[key];
		if (value !== undefined) env[key] = value;
	}

	for (const key of config.include) {
		const value = sourceEnv[key];
		if (value !== undefined) env[key] = value;
	}

	for (const [key, value] of Object.entries(config.set)) {
		env[key] = value;
	}

	return env;
}
