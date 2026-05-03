import * as canonicalLog from "../canonical-log.ts";
import type { GitHubClient, GitHubIssue } from "../github-client.ts";
import { issueKey, issueNumber, type RepoSlug } from "../types/brands.ts";
import { err, ok } from "../types/result.ts";
import { decorateTracker } from "./decorator.ts";
import type { Issue, TrackerAdapter, TrackerState } from "./types.ts";

type IssueState = "open" | "closed" | "all";

type GitHubTrackerOptions = {
	repos: readonly RepoSlug[];
	triggerLabel: string;
	activeStates?: readonly IssueState[];
};

function mapGitHubIssue(repo: RepoSlug, i: GitHubIssue): Issue {
	return {
		key: issueKey(`${repo}#${i.number}`),
		number: issueNumber(i.number),
		repo,
		title: i.title,
		description: i.body ?? "",
		labels: i.labels.map((l) => l.name),
		url: i.html_url,
		createdAt: i.created_at,
	};
}

export function githubTrackerAdapter(
	client: GitHubClient,
	options: GitHubTrackerOptions,
): TrackerAdapter {
	const { repos, triggerLabel, activeStates = ["open"] as const } = options;
	const stateLabels: Record<Exclude<TrackerState, "pending">, string> = {
		running: `${triggerLabel}:running`,
		awaiting_review: `${triggerLabel}:awaiting-review`,
	};

	let usernamePromise: Promise<string> | undefined;
	function getUsername(): Promise<string> {
		usernamePromise ??= client.getAuthenticatedUser().then((u) => u.login);
		return usernamePromise;
	}

	async function fetchPending(repo: RepoSlug): Promise<Issue[]> {
		const username = await getUsername();
		const batches = await Promise.all(
			activeStates.map((s) =>
				client.searchIssues(
					`repo:${repo} type:issue author:${username} state:${s} label:${triggerLabel} -label:${stateLabels.running} -label:${stateLabels.awaiting_review}`,
				),
			),
		);
		return dedupe(batches.flat()).map((i) => mapGitHubIssue(repo, i));
	}

	async function fetchByStateLabel(
		repo: RepoSlug,
		stateLabel: string,
	): Promise<Issue[]> {
		const username = await getUsername();
		const batches = await Promise.all(
			activeStates.map((s) =>
				client.listIssues(repo, {
					labels: `${triggerLabel},${stateLabel}`,
					state: s,
					creator: username,
					per_page: "100",
				}),
			),
		);
		return dedupe(batches.flat()).map((i) => mapGitHubIssue(repo, i));
	}

	function dedupe(issues: GitHubIssue[]): GitHubIssue[] {
		const seen = new Set<number>();
		return issues.filter((i) => {
			if (seen.has(i.number)) return false;
			seen.add(i.number);
			return true;
		});
	}

	async function fetchForRepo(
		repo: RepoSlug,
		state: TrackerState,
	): Promise<Issue[]> {
		if (state === "pending") return fetchPending(repo);
		return fetchByStateLabel(repo, stateLabels[state]);
	}

	return decorateTracker({
		async fetchIssue(repo, issueNum): Promise<Issue> {
			const i = await client.getIssue(repo, issueNum);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(state) {
			const results = await Promise.allSettled(
				repos.map(async (repo) => ({
					repo,
					issues: await fetchForRepo(repo, state),
				})),
			);
			const issues: Issue[] = [];
			const reposReached = new Set<RepoSlug>();
			for (const [i, result] of results.entries()) {
				if (result.status === "fulfilled") {
					reposReached.add(result.value.repo);
					issues.push(...result.value.issues);
				} else {
					canonicalLog.append(
						"warnings",
						`fetch_active_issues_failed: ${repos[i]}`,
					);
				}
			}
			return { issues, reposReached };
		},

		async transitionState(repo, issueNum, from, to): Promise<void> {
			await Promise.all([
				from === "pending"
					? Promise.resolve()
					: client.removeIssueLabel(repo, issueNum, stateLabels[from]),
				to === "pending"
					? Promise.resolve()
					: client.addIssueLabels(repo, issueNum, [stateLabels[to]]),
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
				number: issueNumber(Number.parseInt(rawNumber, 10)),
			});
		},
	});
}
