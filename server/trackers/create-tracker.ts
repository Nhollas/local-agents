import type { Config } from "../config.ts";
import { createJiraClient } from "../jira-client.ts";
import { jiraTrackerAdapter } from "./jira.ts";
import type { TrackerAdapter } from "./types.ts";

export function createTracker(
	tracker: Config["tracker"],
	scopes: Config["code_host"]["scopes"],
	tokens: { jiraEmail: string | undefined; jiraApiToken: string | undefined },
): TrackerAdapter {
	switch (tracker.kind) {
		case "jira": {
			if (!tokens.jiraEmail) {
				throw new Error("JIRA_EMAIL is required for Jira tracker");
			}
			if (!tokens.jiraApiToken) {
				throw new Error("JIRA_API_TOKEN is required for Jira tracker");
			}
			const client = createJiraClient({
				baseUrl: tracker.base_url,
				email: tokens.jiraEmail,
				apiToken: tokens.jiraApiToken,
			});
			return jiraTrackerAdapter(client, {
				project: tracker.project,
				scopes,
				baseUrl: tracker.base_url,
				statuses: tracker.statuses,
				triggerLabel: tracker.trigger_label,
			});
		}
	}
}
