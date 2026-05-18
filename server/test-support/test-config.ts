import type { AppConfigShape } from "../config/app-config.ts";
import {
	GITLAB_BASE_URL,
	JIRA_BASE_URL,
	JIRA_PROJECT,
	REPO,
	STATUSES,
	TRIGGER_LABEL,
} from "./fixtures.ts";

export function createTestConfig(
	overrides: Partial<AppConfigShape["defaults"]> = {},
): AppConfigShape {
	return {
		tracker: {
			kind: "jira",
			base_url: JIRA_BASE_URL,
			project: JIRA_PROJECT,
			trigger_label: TRIGGER_LABEL,
			statuses: { ...STATUSES },
		},
		code_host: {
			kind: "gitlab",
			base_url: GITLAB_BASE_URL,
			scopes: [REPO],
		},
		defaults: {
			polling_interval_ms: 100,
			max_concurrent: 2,
			workspace_root: "/tmp/test-workspaces",
			log_dir: "/tmp/test-logs",
			...overrides,
		},
		agent: {
			env: {
				include: [],
				set: {},
			},
		},
	};
}
