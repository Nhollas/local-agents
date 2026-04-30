import type { GitHubClient, GitHubIssue } from "../github-client.ts";
import {
	issueKey,
	issueNumber,
	type RepoSlug,
	repoSlug,
} from "../types/brands.ts";
import { err, ok } from "../types/result.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type IssueState = "open" | "closed" | "all";

const LABELS: Record<TrackerState, string> = {
	pending: "agent",
	running: "agent:running",
	awaiting_review: "agent:awaiting-review",
};

function mapGitHubIssue(repo: RepoSlug, i: GitHubIssue): Issue {
	return {
		key: issueKey(`${repo}#${i.number}`),
		number: issueNumber(i.number),
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
		async fetchIssue(repo, issueNum): Promise<Issue> {
			const i = await client.getIssue(repo, issueNum);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(repo, state): Promise<Issue[]> {
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

		async transitionState(repo, issueNum, from, to): Promise<void> {
			await Promise.all([
				client.removeIssueLabel(repo, issueNum, LABELS[from]),
				client.addIssueLabels(repo, issueNum, [LABELS[to]]),
			]);
		},

		parseIssueKey(key) {
			const hashIndex = key.lastIndexOf("#");
			if (hashIndex <= 0 || hashIndex === key.length - 1) {
				return err({
					kind: "invalid_format",
					input: key,
					message: `Invalid GitHub issue key: ${key}`,
				});
			}

			const rawNumber = key.slice(hashIndex + 1);
			if (!/^\d+$/.test(rawNumber)) {
				return err({
					kind: "invalid_format",
					input: key,
					message: `Invalid GitHub issue key: ${key}`,
				});
			}

			return ok({
				repo: repoSlug(key.slice(0, hashIndex)),
				number: issueNumber(Number.parseInt(rawNumber, 10)),
			});
		},
	});
}
