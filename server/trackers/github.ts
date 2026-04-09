import type { GitHubClient, GitHubIssue } from "../github-client.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter } from "./types.ts";

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
	const usernamePromise = client.getAuthenticatedUser().then((u) => u.login);

	return decorateTracker({
		async fetchIssue(repo: string, issueNumber: number): Promise<Issue> {
			const i = await client.getIssue(repo, issueNumber);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(repo: string, label: string): Promise<Issue[]> {
			const username = await usernamePromise;

			const batches = await Promise.all(
				activeStates.map((state) =>
					client.listIssues(repo, {
						labels: label,
						state,
						creator: username,
						per_page: "100",
					}),
				),
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
				client.removeIssueLabel(repo, issueNumber, remove),
				client.addIssueLabels(repo, issueNumber, [add]),
			]);
		},
	});
}
