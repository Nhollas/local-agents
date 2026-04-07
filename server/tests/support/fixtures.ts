import type { RepoWorkflow } from "../../workflow/workflow.ts";

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

// biome-ignore lint/correctness/useYield: throws before yielding
export async function* failingAgent() {
	throw new Error("agent exploded");
}

type ContentBlock = { type: "text"; text: string } | { type: string };

export function createSessionAgent(
	sessionId: string,
	content: ContentBlock[] = [],
) {
	return async function* sessionAgent() {
		yield {
			type: "assistant" as const,
			session_id: sessionId,
			// biome-ignore lint/suspicious/noExplicitAny: decouple test fixture from SDK's BetaMessage shape
			message: { content } as any,
			parent_tool_use_id: null,
			uuid: "00000000-0000-0000-0000-000000000001" as const,
		};
	};
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
