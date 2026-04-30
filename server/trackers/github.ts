import type { GitHubClient, GitHubIssue } from "../github-client.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type IssueState = "open" | "closed" | "all";

const LABELS: Record<TrackerState, string> = {
	pending: "agent",
	running: "agent:running",
	awaiting_review: "agent:awaiting-review",
};

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
	let usernamePromise: Promise<string> | undefined;
	function getUsername(): Promise<string> {
		usernamePromise ??= client.getAuthenticatedUser().then((u) => u.login);
		return usernamePromise;
	}

	return decorateTracker({
		async fetchIssue(repo: string, issueNumber: number): Promise<Issue> {
			const i = await client.getIssue(repo, issueNumber);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(
			repo: string,
			state: TrackerState,
		): Promise<Issue[]> {
			const username = await getUsername();
			const label = LABELS[state];

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

		async transitionState(
			repo: string,
			issueNumber: number,
			from: TrackerState,
			to: TrackerState,
		): Promise<void> {
			await Promise.all([
				client.removeIssueLabel(repo, issueNumber, LABELS[from]),
				client.addIssueLabels(repo, issueNumber, [LABELS[to]]),
			]);
		},

		parseIssueKey(key: string): { repo: string; number: number } {
			const hashIndex = key.lastIndexOf("#");
			if (hashIndex <= 0 || hashIndex === key.length - 1) {
				throw new Error(`Invalid GitHub issue key: ${key}`);
			}

			const rawNumber = key.slice(hashIndex + 1);
			if (!/^\d+$/.test(rawNumber)) {
				throw new Error(`Invalid GitHub issue key: ${key}`);
			}

			return {
				repo: key.slice(0, hashIndex),
				number: Number.parseInt(rawNumber, 10),
			};
		},
	});
}
