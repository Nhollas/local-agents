import { gh } from "../gh.ts";
import type { Issue, TrackerAdapter } from "../types.ts";

type GitHubIssue = {
	number: number;
	title: string;
	body: string | null;
	labels: { name: string }[];
	html_url: string;
	created_at: string;
};

async function getAuthenticatedUser(): Promise<string> {
	const stdout = await gh("api", "user", "--jq", ".login");
	return stdout;
}

export function createGitHubTracker(
	activeStates: string[] = ["open"],
): TrackerAdapter {
	const usernamePromise = getAuthenticatedUser();

	return {
		async fetchActiveIssues(repo: string, label: string): Promise<Issue[]> {
			const username = await usernamePromise;
			const results: GitHubIssue[] = [];

			for (const state of activeStates) {
				const stdout = await gh(
					"api",
					`repos/${repo}/issues`,
					"--method",
					"GET",
					"-f",
					`labels=${label}`,
					"-f",
					`state=${state}`,
					"-f",
					`creator=${username}`,
					"-f",
					"per_page=100",
				);
				results.push(...JSON.parse(stdout));
			}

			const seen = new Set<number>();

			return results
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
			await gh(
				"api",
				`repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(remove)}`,
				"--method",
				"DELETE",
			);
			await gh(
				"api",
				`repos/${repo}/issues/${issueNumber}/labels`,
				"--method",
				"POST",
				"-f",
				`labels[]=${add}`,
			);
		},
	};
}
