import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "./http-client.ts";

const jiraIssueSchema = z.object({
	key: z.string(),
	fields: z.object({
		summary: z.string(),
		description: z.unknown().nullable().optional(),
		created: z.string(),
		status: z.object({
			name: z.string(),
		}),
	}),
});

const jiraSearchSchema = z.object({
	issues: z.array(jiraIssueSchema),
});

const jiraTransitionsSchema = z.object({
	transitions: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			to: z.object({
				name: z.string(),
			}),
		}),
	),
});

export type JiraIssue = z.infer<typeof jiraIssueSchema>;

export type JiraTransition = z.infer<
	typeof jiraTransitionsSchema
>["transitions"][number];

export type JiraClient = {
	getIssue(key: string): Promise<JiraIssue>;
	searchIssues(params: {
		jql: string;
		maxResults?: number;
	}): Promise<JiraIssue[]>;
	listTransitions(key: string): Promise<JiraTransition[]>;
	transitionIssue(key: string, transitionId: string): Promise<void>;
};

type JiraClientOptions = HttpClientOptions & {
	baseUrl: string;
	email: string;
	apiToken: string;
};

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function encodeIssueKey(key: string): string {
	return encodeURIComponent(key);
}

function basicAuth(email: string, apiToken: string): string {
	return Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
	const baseUrl = trimTrailingSlash(options.baseUrl);
	const request = createJsonRequester({
		...options,
		baseUrl: `${baseUrl}/rest/api/3`,
		serviceName: "Jira",
		headers: {
			Authorization: `Basic ${basicAuth(options.email, options.apiToken)}`,
			Accept: "application/json",
		},
	});

	return {
		getIssue(key: string) {
			const query = new URLSearchParams({
				fields: "summary,description,status,created",
			});
			return request(`/issue/${encodeIssueKey(key)}?${query}`, {
				schema: jiraIssueSchema,
			});
		},

		async searchIssues(params: { jql: string; maxResults?: number }) {
			const query = new URLSearchParams({
				jql: params.jql,
				maxResults: String(params.maxResults ?? 100),
				fields: "summary,description,status,created",
			});
			const result = await request(`/search?${query}`, {
				schema: jiraSearchSchema,
			});
			return result.issues;
		},

		async listTransitions(key: string) {
			const result = await request(
				`/issue/${encodeIssueKey(key)}/transitions`,
				{
					schema: jiraTransitionsSchema,
				},
			);
			return result.transitions;
		},

		transitionIssue(key: string, transitionId: string) {
			return request(`/issue/${encodeIssueKey(key)}/transitions`, {
				method: "POST",
				body: {
					transition: {
						id: transitionId,
					},
				},
			});
		},
	};
}
