import { z } from "zod";
import type { GitHubClient } from "../github-client.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter } from "./types.ts";

const githubUserSchema = z.object({
	login: z.string(),
});

const githubIssueSchema = z.object({
	number: z.number(),
	title: z.string(),
	body: z.string().nullable(),
	labels: z.array(z.object({ name: z.string() })),
	html_url: z.string(),
	created_at: z.string(),
});

type GitHubIssue = z.infer<typeof githubIssueSchema>;
const githubIssuesSchema = z.array(githubIssueSchema);

type IssueState = "open" | "closed" | "all";

function mapGitHubIssue(repo: string, i: GitHubIssue): Issue {
	return {
		key: `${repo}#${i.number}`,
		number: i.number,
		title: i.title,
		description: i.body ?? "",
		labels: i.labels.map((l) => l.name),
		url: i.html_url,
		createdAt: i.created_at,
	};
}

export function githubTrackerAdapter(
	client: GitHubClient,
	activeStates: IssueState[] = ["open"],
): TrackerAdapter {
	const usernamePromise = client
		.get("/user", githubUserSchema)
		.then((u) => u.login);

	return decorateTracker({
		async fetchIssue(repo: string, issueNumber: number): Promise<Issue> {
			const i = await client.get(
				`/repos/${repo}/issues/${issueNumber}`,
				githubIssueSchema,
			);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(repo: string, label: string): Promise<Issue[]> {
			const username = await usernamePromise;

			const batches = await Promise.all(
				activeStates.map((state) => {
					const params = new URLSearchParams({
						labels: label,
						state,
						creator: username,
						per_page: "100",
					});
					return client.get(
						`/repos/${repo}/issues?${params}`,
						githubIssuesSchema,
					);
				}),
			);

			const seen = new Set<number>();

			return batches
				.flat()
				.filter((i) => {
					if (seen.has(i.number)) return false;
					seen.add(i.number);
					return true;
				})
				.map((i) => mapGitHubIssue(repo, i));
		},

		async swapLabel(
			repo: string,
			issueNumber: number,
			remove: string,
			add: string,
		): Promise<void> {
			await Promise.all([
				client.delete(
					`/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(remove)}`,
				),
				client.post(`/repos/${repo}/issues/${issueNumber}/labels`, {
					labels: [add],
				}),
			]);
		},
	});
}
