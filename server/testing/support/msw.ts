import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import {
	type createJiraIssue,
	GITLAB_API,
	GITLAB_BASE_URL,
	JIRA_API,
	REPO,
	STATUSES,
	type StatusKey,
} from "./fixtures.ts";

// Always-on handlers: every dispatch resolves the repo's default branch
// before doing anything else. Tests that care about the value can override
// with server.use(...).
const defaultHandlers = [
	http.get(`${GITLAB_API}/projects/:project`, () =>
		HttpResponse.json({ default_branch: "main" }),
	),
];

export const server = setupServer(...defaultHandlers);

type JiraIssue = ReturnType<typeof createJiraIssue>;

export const TRANSITIONS = [
	{ id: "11", name: "Start", to: { name: STATUSES.running } },
	{ id: "21", name: "Review", to: { name: STATUSES.awaiting_review } },
	{ id: "31", name: "Reopen", to: { name: STATUSES.pending } },
];

function statusFromJql(jql: string): StatusKey | null {
	if (jql.includes(`status = "${STATUSES.running}"`)) return "running";
	if (jql.includes(`status = "${STATUSES.awaiting_review}"`))
		return "awaiting_review";
	if (jql.includes(`status = "${STATUSES.pending}"`)) return "pending";
	return null;
}

export function jiraHandlers({
	issues = [],
	resolveIssues,
}: {
	issues?: JiraIssue[];
	resolveIssues?: (status: StatusKey) => JiraIssue[];
} = {}) {
	const resolve =
		resolveIssues ??
		((status: StatusKey) => (status === "pending" ? issues : []));

	return [
		http.post(`${JIRA_API}/search/jql`, async ({ request }) => {
			const body = (await request.json()) as { jql?: string };
			const status = statusFromJql(body.jql ?? "");
			if (!status) return HttpResponse.json({ issues: [] });
			return HttpResponse.json({ issues: resolve(status) });
		}),
		http.get(`${JIRA_API}/issue/:key/transitions`, () =>
			HttpResponse.json({ transitions: TRANSITIONS }),
		),
		http.post(
			`${JIRA_API}/issue/:key/transitions`,
			() => new HttpResponse(null, { status: 204 }),
		),
		http.put(
			`${JIRA_API}/issue/:key`,
			() => new HttpResponse(null, { status: 204 }),
		),
	];
}

export function gitlabHandlers() {
	return [
		http.get(`${GITLAB_API}/projects/:project/merge_requests`, () =>
			HttpResponse.json([]),
		),
		http.post(`${GITLAB_API}/projects/:project/merge_requests`, () =>
			HttpResponse.json({
				iid: 1,
				web_url: `${GITLAB_BASE_URL}/${REPO}/-/merge_requests/1`,
			}),
		),
	];
}
