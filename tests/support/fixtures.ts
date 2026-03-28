import type { RepoWorkflow } from "../../core/types.ts";

export const GITHUB_API = "https://api.github.com";
export const REPO = "test-owner/test-repo";

export function createGitHubIssue(
	number: number,
	labels: string[],
	createdAt = "2025-01-01T00:00:00Z",
) {
	return {
		number,
		title: `Issue ${number}`,
		body: `Description for issue ${number}`,
		labels: labels.map((name) => ({ name })),
		html_url: `https://github.com/${REPO}/issues/${number}`,
		created_at: createdAt,
	};
}

export async function* noopAgent() {}

export async function* hangingAgent() {
	await new Promise(() => {});
}

export function createTestWorkflow(
	overrides: Partial<RepoWorkflow> = {},
): RepoWorkflow {
	return {
		branch: "agent/issue-{{ issue.number }}",
		base_branch: "main",
		prompt: "Fix issue {{ issue.number }}: {{ issue.title }}",
		...overrides,
	};
}
