import type { query } from "@anthropic-ai/claude-agent-sdk";
import { repoSlug } from "../types/brands.ts";
import {
	type AgentInvokeOptions,
	type AgentInvokerService,
	type AgentMessage,
	DEFAULT_ALLOWED_TOOLS,
} from "../workflow/agent-invoker.ts";
import type { RepoWorkflow } from "../workflow/types.ts";

type QueryParams = Parameters<typeof query>[0];
export type TestRunAgent = (params: QueryParams) => AsyncIterable<AgentMessage>;

export function adaptRunAgent(
	runAgent: TestRunAgent,
	cwd: string = process.cwd(),
): AgentInvokerService {
	return {
		invoke({ prompt, model, resumeSessionId }: AgentInvokeOptions) {
			return runAgent({
				prompt,
				options: {
					cwd,
					model,
					allowedTools: [...DEFAULT_ALLOWED_TOOLS],
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

export function syntheticSuccessResult(
	overrides: { sessionId?: string } = {},
): AgentMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 0,
		duration_api_ms: 0,
		is_error: false,
		num_turns: 1,
		result: "",
		stop_reason: null,
		total_cost_usd: 0,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
		uuid: "00000000-0000-4000-8000-000000000001",
		session_id: overrides.sessionId ?? "test-session",
	} as unknown as AgentMessage;
}

export async function* noopAgent() {
	yield syntheticSuccessResult();
}

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
				model: "claude-sonnet-4-6",
				measure_diff: false,
			},
		],
		change_request: {
			title: "{{ issue.title }}",
			body: "Closes {{ issue.key }}",
		},
		...overrides,
	};
}
