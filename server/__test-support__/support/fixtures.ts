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

export const GITLAB_BASE_URL = "https://gitlab.example.test";
export const GITLAB_API = `${GITLAB_BASE_URL}/api/v4`;
export const GITHUB_API = "https://api.github.com";
export const JIRA_BASE_URL = "https://jira.example.test";
export const JIRA_API = `${JIRA_BASE_URL}/rest/api/2`;
export const JIRA_PROJECT = "TEST";
export const TRIGGER_LABEL = "agent";
export const REPO = repoSlug("test-owner/test-repo");

export const STATUSES = {
	pending: "To Do",
	running: "In Progress",
	awaiting_review: "In Review",
} as const;

export function jiraIssueKey(num: number): string {
	return `${JIRA_PROJECT}-${num}`;
}

export function createJiraIssue(
	key: string,
	status: string = STATUSES.pending,
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

export async function* noopAgent() {}

export async function* hangingAgent() {
	await new Promise(() => {});
}

export function createTestWorkflow(
	overrides: Partial<RepoWorkflow> = {},
): RepoWorkflow {
	return {
		branch: "agent/issue-{{ issue.number }}",
		steps: [
			{
				name: "prompt",
				prompt: "Fix issue {{ issue.number }}: {{ issue.title }}",
				resume_previous: false,
			},
		],
		change_request: {
			title: "{{ issue.title }}",
			body: "Closes {{ issue.key }}",
		},
		...overrides,
	};
}
