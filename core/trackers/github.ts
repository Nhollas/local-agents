import type { GitHubClient } from "../gh.ts";
import type { Issue, TrackerAdapter } from "../types.ts";
import { decorateTracker } from "./decorator.ts";

type GitHubIssue = {
	number: number;
	title: string;
	body: string | null;
	labels: { name: string }[];
	html_url: string;
	created_at: string;
};

type GitHubUser = {
	login: string;
};

type IssueState = "open" | "closed" | "all";

export function githubTrackerAdapter(
	client: GitHubClient,
	activeStates: IssueState[] = ["open"],
): TrackerAdapter {
	const usernamePromise = client.get<GitHubUser>("/user").then((u) => u.login);

	return decorateTracker({
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
					return client.get<GitHubIssue[]>(`/repos/${repo}/issues?${params}`);
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
				.map((i) => ({
					key: `${repo}#${i.number}`,
					number: i.number,
					title: i.title,
					description: i.body ?? "",
					labels: i.labels.map((l) => l.name),
					url: i.html_url,
					createdAt: i.created_at,
				}));
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
