export const GITLAB_BASE_URL = "https://gitlab.example.test";
export const GITLAB_API = `${GITLAB_BASE_URL}/api/v4`;
export const GITHUB_API = "https://api.github.com";
export const JIRA_BASE_URL = "https://jira.example.test";
export const JIRA_API = `${JIRA_BASE_URL}/rest/api/2`;
export const REPO = "test-owner/test-repo";

export function createJiraIssue(
	key: string,
	status: string = "To Do",
	created = "2025-01-01T00:00:00.000+0000",
	labels: string[] = [],
) {
	return {
		key,
		fields: {
			summary: `Issue ${key}`,
			description: `Description for ${key}`,
			created,
			labels,
			status: { name: status },
		},
	};
}
