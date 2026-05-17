import type { HttpClient } from "@effect/platform";
import { Effect } from "effect";
import type { Config } from "../config.ts";
import { TrackerConfigError } from "./errors.ts";
import { createJiraTracker } from "./jira-tracker.ts";
import type { TrackerAdapter } from "./types.ts";

export const createTracker = (
	tracker: Config["tracker"],
	scopes: Config["code_host"]["scopes"],
	tokens: { jiraEmail: string | undefined; jiraApiToken: string | undefined },
): Effect.Effect<TrackerAdapter, TrackerConfigError, HttpClient.HttpClient> => {
	switch (tracker.kind) {
		case "jira": {
			if (!tokens.jiraEmail) {
				return Effect.fail(
					new TrackerConfigError({
						message: "JIRA_EMAIL is required for Jira tracker",
					}),
				);
			}
			if (!tokens.jiraApiToken) {
				return Effect.fail(
					new TrackerConfigError({
						message: "JIRA_API_TOKEN is required for Jira tracker",
					}),
				);
			}
			return createJiraTracker({
				project: tracker.project,
				scopes,
				baseUrl: tracker.base_url,
				statuses: tracker.statuses,
				triggerLabel: tracker.trigger_label,
				email: tokens.jiraEmail,
				apiToken: tokens.jiraApiToken,
			});
		}
	}
};
