import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type createGitHubIssue, GITHUB_API, REPO } from "./fixtures.ts";

export const server = setupServer();

type GitHubIssue = ReturnType<typeof createGitHubIssue>;

export function githubHandlers({
	issues = [],
	resolveIssues,
	onLabelDelete,
	onLabelAdd,
}: {
	issues?: GitHubIssue[];
	resolveIssues?: (label: string) => GitHubIssue[];
	onLabelDelete?: (label: string) => void;
	onLabelAdd?: (label: string) => void;
} = {}) {
	const resolve =
		resolveIssues ?? ((label: string) => (label === "agent" ? issues : []));

	return [
		http.get(`${GITHUB_API}/user`, () =>
			HttpResponse.json({ login: "test-user" }),
		),
		http.get(`${GITHUB_API}/repos/${REPO}/issues`, ({ request }) => {
			const url = new URL(request.url);
			const label = url.searchParams.get("labels");
			return HttpResponse.json(label ? resolve(label) : []);
		}),
		http.delete(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
			({ params }) => {
				onLabelDelete?.(params.label as string);
				return new HttpResponse(null, { status: 204 });
			},
		),
		http.post(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				onLabelAdd?.(body.labels[0]);
				return HttpResponse.json([]);
			},
		),
		http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
			HttpResponse.json({
				number: 1,
				html_url: `https://github.com/${REPO}/pull/1`,
			}),
		),
	];
}
