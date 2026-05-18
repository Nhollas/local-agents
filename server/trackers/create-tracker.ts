import type { HttpClient } from "@effect/platform";
import { Config, type ConfigError, Effect, Match, Redacted } from "effect";
import { AppConfig } from "../config/app-config.ts";
import { createJiraTracker } from "./jira-tracker.ts";
import type { TrackerAdapter } from "./types.ts";

export const createTracker: Effect.Effect<
	TrackerAdapter,
	ConfigError.ConfigError,
	HttpClient.HttpClient | AppConfig
> = Effect.gen(function* () {
	const { tracker, code_host } = yield* AppConfig;
	return yield* Match.value(tracker).pipe(
		Match.discriminator("kind")("jira", (t) =>
			Effect.gen(function* () {
				const email = yield* Config.redacted("JIRA_EMAIL");
				const apiToken = yield* Config.redacted("JIRA_API_TOKEN");
				return yield* createJiraTracker({
					project: t.project,
					scopes: code_host.scopes,
					baseUrl: t.base_url,
					statuses: t.statuses,
					triggerLabel: t.trigger_label,
					email: Redacted.value(email),
					apiToken: Redacted.value(apiToken),
				});
			}),
		),
		Match.exhaustive,
	);
});
