import type { query } from "@anthropic-ai/claude-agent-sdk";
import {
	type AgentInvokeOptions,
	type AgentInvoker,
	type AgentMessage,
	ALLOWED_TOOLS,
} from "../../orchestrator/agent-invoker.ts";
import { repoSlug } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";

type QueryParams = Parameters<typeof query>[0];
export type LegacyRunAgent = (
	params: QueryParams,
) => AsyncIterable<AgentMessage>;

export function adaptRunAgent(runAgent: LegacyRunAgent): AgentInvoker {
	return {
		invoke({ prompt, cwd, model, resumeSessionId }: AgentInvokeOptions) {
			return runAgent({
				prompt,
				options: {
					cwd,
					model,
					allowedTools: [...ALLOWED_TOOLS],
					permissionMode: "dontAsk" as const,
					...(resumeSessionId && { resume: resumeSessionId }),
				},
			});
		},
	};
}

export const GITHUB_API = "https://api.github.com";
export const GITLAB_BASE_URL = "https://gitlab.example.test";
export const GITLAB_API = `${GITLAB_BASE_URL}/api/v4`;
export const JIRA_BASE_URL = "https://jira.example.test";
export const JIRA_API = `${JIRA_BASE_URL}/rest/api/3`;
export const REPO = repoSlug("test-owner/test-repo");

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

export function createJiraIssue(
	key: string,
	status = "To Do",
	created = "2025-01-01T00:00:00.000+0000",
) {
	return {
		key,
		fields: {
			summary: `Issue ${key}`,
			description: {
				type: "doc",
				version: 1,
				content: [
					{
						type: "paragraph",
						content: [{ type: "text", text: `Description for ${key}` }],
					},
				],
			},
			created,
			status: { name: status },
		},
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
		steps: [
			{
				name: "prompt",
				prompt: "Fix issue {{ issue.number }}: {{ issue.title }}",
				resume_previous: false,
			},
		],
		...overrides,
	};
}
