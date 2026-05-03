import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { type createGitHubIssue, GITHUB_API, REPO } from "./fixtures.ts";

export const server = setupServer();

type GitHubIssue = ReturnType<typeof createGitHubIssue>;

const CANONICAL_LABELS = new Set([
	"agent",
	"agent:running",
	"agent:awaiting-review",
]);

export function githubHandlers({
	issues = [],
	resolveIssues,
}: {
	issues?: GitHubIssue[];
	resolveIssues?: (label: string) => GitHubIssue[];
} = {}) {
	const resolve =
		resolveIssues ?? ((label: string) => (label === "agent" ? issues : []));

	return [
		http.get(`${GITHUB_API}/user`, () =>
			HttpResponse.json({ login: "test-user" }),
		),
		http.get(`${GITHUB_API}/repos/${REPO}/issues/:number`, ({ params }) => {
			const num = Number(params["number"]);
			const all = resolve("agent").concat(resolve("agent:running"));
			const issue = all.find((i) => i.number === num);
			if (!issue) return new HttpResponse(null, { status: 404 });
			return HttpResponse.json(issue);
		}),
		http.get(`${GITHUB_API}/search/issues`, ({ request }) => {
			const q = new URL(request.url).searchParams.get("q") ?? "";
			const positive = new Set(
				q.split(/\s+/).filter((t) => t.startsWith("label:")),
			);
			if (!positive.has("label:agent")) {
				return HttpResponse.json({ total_count: 0, items: [] });
			}
			let items: GitHubIssue[];
			if (positive.has("label:agent:running")) {
				items = resolve("agent:running");
			} else if (positive.has("label:agent:awaiting-review")) {
				items = resolve("agent:awaiting-review");
			} else {
				items = resolve("agent");
			}
			return HttpResponse.json({ total_count: items.length, items });
		}),
		http.delete<{ label: string }>(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels/:label`,
			({ params }) => {
				if (!CANONICAL_LABELS.has(decodeURIComponent(params.label))) {
					return new HttpResponse(null, { status: 400 });
				}
				return new HttpResponse(null, { status: 204 });
			},
		),
		http.post<{ number: string }>(
			`${GITHUB_API}/repos/${REPO}/issues/:number/labels`,
			async ({ request }) => {
				const body = (await request.json()) as { labels: string[] };
				const label = body.labels[0];
				if (!label || !CANONICAL_LABELS.has(label)) {
					return new HttpResponse(null, { status: 400 });
				}
				return HttpResponse.json([]);
			},
		),
		http.get(`${GITHUB_API}/repos/${REPO}/pulls`, () => HttpResponse.json([])),
		http.post(`${GITHUB_API}/repos/${REPO}/pulls`, () =>
			HttpResponse.json({
				number: 1,
				html_url: `https://github.com/${REPO}/pull/1`,
			}),
		),
	];
}
