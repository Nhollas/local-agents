import * as canonicalLog from "../canonical-log.ts";
import type { GitHubClient, GitHubIssue } from "../github-client.ts";
import { resolveRepo } from "../scope-resolver.ts";
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

type GitHubTrackerOptions = {
	scopes: readonly RepoSlug[];
	triggerLabel: string;
	activeStates?: readonly IssueState[];
};

const REPOSITORY_URL_PATTERN = /\/repos\/([^/]+\/[^/]+)$/;

function parseRepoFromUrl(url: string | undefined): RepoSlug | null {
	if (!url) return null;
	const match = REPOSITORY_URL_PATTERN.exec(url);
	return match?.[1] ? repoSlug(match[1]) : null;
}

function orgOf(scope: RepoSlug): string {
	const slash = scope.indexOf("/");
	return slash === -1 ? scope : scope.slice(0, slash);
}

function distinctOrgs(scopes: readonly RepoSlug[]): string[] {
	return [...new Set(scopes.map(orgOf))];
}

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
	const { scopes, triggerLabel, activeStates = ["open"] as const } = options;
	const stateLabels: Record<Exclude<TrackerState, "pending">, string> = {
		running: `${triggerLabel}:running`,
		awaiting_review: `${triggerLabel}:awaiting-review`,
	};
	const failedLabel = `${triggerLabel}-failed`;
	const orgs = distinctOrgs(scopes);

	let usernamePromise: Promise<string> | undefined;
	function getUsername(): Promise<string> {
		usernamePromise ??= client.getAuthenticatedUser().then((u) => u.login);
		return usernamePromise;
	}

	type OrgSearchResult = {
		org: string;
		items: readonly GitHubIssue[] | null;
	};

	async function searchAcrossOrgs(suffix: string): Promise<OrgSearchResult[]> {
		const username = await getUsername();
		return Promise.all(
			orgs.map(async (org) => {
				const batches = await Promise.all(
					activeStates.map((s) =>
						client
							.searchIssues(
								`org:${org} type:issue author:${username} state:${s} ${suffix}`,
							)
							.catch((err: unknown) => {
								canonicalLog.append(
									"warnings",
									`fetch_active_issues_failed: org=${org} ${canonicalLog.errorMessage(err)}`,
								);
								return null;
							}),
					),
				);
				const failed = batches.some((b) => b === null);
				const items = failed ? null : dedupe(batches.flatMap((b) => b ?? []));
				return { org, items };
			}),
		);
	}

	function scopesForOrgs(reachedOrgs: ReadonlySet<string>): RepoSlug[] {
		return scopes.filter((s) => reachedOrgs.has(orgOf(s)));
	}

	function dedupe(issues: GitHubIssue[]): GitHubIssue[] {
		const seen = new Set<string>();
		return issues.filter((i) => {
			if (seen.has(i.html_url)) return false;
			seen.add(i.html_url);
			return true;
		});
	}

	function resolveAndMap(items: readonly GitHubIssue[]): Issue[] {
		const issues: Issue[] = [];
		for (const item of items) {
			const repoFromUrl = parseRepoFromUrl(item.repository_url);
			if (!repoFromUrl) continue;
			const resolved = resolveRepo(repoFromUrl, scopes);
			if (!resolved) continue;
			issues.push(mapGitHubIssue(resolved, item));
		}
		return issues;
	}

	function suffixForState(state: TrackerState): string {
		if (state === "pending") {
			return `label:${triggerLabel} -label:${stateLabels.running} -label:${stateLabels.awaiting_review}`;
		}
		return `label:${triggerLabel} label:${stateLabels[state]}`;
	}

	return decorateTracker({
		async fetchIssue(repo, issueNum): Promise<Issue> {
			const i = await client.getIssue(repo, issueNum);
			return mapGitHubIssue(repo, i);
		},

		async fetchActiveIssues(state) {
			const results = await searchAcrossOrgs(suffixForState(state));
			const reachedOrgs = new Set(
				results.filter((r) => r.items !== null).map((r) => r.org),
			);
			const items = results.flatMap((r) => r.items ?? []);
			return {
				issues: resolveAndMap(items),
				scopesReached: new Set(scopesForOrgs(reachedOrgs)),
			};
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

		async markFailed(repo, issueNum): Promise<void> {
			await Promise.all([
				client.addIssueLabels(repo, issueNum, [failedLabel]),
				client.removeIssueLabel(repo, issueNum, triggerLabel),
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
