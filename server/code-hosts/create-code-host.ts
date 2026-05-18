import type { HttpClient } from "@effect/platform";
import { Config, type ConfigError, Effect, Match, Redacted } from "effect";
import { AppConfig } from "../config/app-config.ts";
import { createGitHubAdapter } from "./github.ts";
import { createGitLabAdapter } from "./gitlab.ts";
import type { CodeHostAdapter } from "./types.ts";

export const createCodeHost: Effect.Effect<
	CodeHostAdapter,
	ConfigError.ConfigError,
	HttpClient.HttpClient | AppConfig
> = Effect.gen(function* () {
	const { code_host } = yield* AppConfig;
	return yield* Match.value(code_host).pipe(
		Match.discriminator("kind")("gitlab", (c) =>
			Effect.gen(function* () {
				const token = Redacted.value(yield* Config.redacted("GITLAB_TOKEN"));
				return yield* createGitLabAdapter({
					token,
					baseUrl: c.base_url,
					cloneToken: token,
				});
			}),
		),
		Match.discriminator("kind")("github", () =>
			Effect.gen(function* () {
				const token = Redacted.value(yield* Config.redacted("GITHUB_TOKEN"));
				return yield* createGitHubAdapter({ token, cloneToken: token });
			}),
		),
		Match.exhaustive,
	);
});
