import type { HttpClient } from "@effect/platform";
import { Effect } from "effect";
import type { Config } from "../config.ts";
import { CodeHostConfigError } from "./errors.ts";
import { createGitHubAdapter } from "./github.ts";
import { createGitLabAdapter } from "./gitlab.ts";
import type { CodeHostAdapter } from "./types.ts";

export const createCodeHost = (
	codeHost: Config["code_host"],
	tokens: { gitlab: string | undefined; github: string | undefined },
): Effect.Effect<
	CodeHostAdapter,
	CodeHostConfigError,
	HttpClient.HttpClient
> => {
	switch (codeHost.kind) {
		case "gitlab": {
			if (!tokens.gitlab) {
				return Effect.fail(
					new CodeHostConfigError({
						message: "GITLAB_TOKEN is required for GitLab code host",
					}),
				);
			}
			return createGitLabAdapter({
				token: tokens.gitlab,
				baseUrl: codeHost.base_url,
				cloneToken: tokens.gitlab,
			});
		}
		case "github": {
			if (!tokens.github) {
				return Effect.fail(
					new CodeHostConfigError({
						message: "GITHUB_TOKEN is required for GitHub code host",
					}),
				);
			}
			return createGitHubAdapter({
				token: tokens.github,
				cloneToken: tokens.github,
			});
		}
	}
};
