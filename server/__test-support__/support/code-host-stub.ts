import type { CodeHostAdapter } from "../../code-hosts/types.ts";
import type { RepoSlug } from "../../types/brands.ts";

type ChangeRequestRecord = {
	repo: RepoSlug;
	head: string;
	base: string;
	title: string;
	body: string;
};

type CodeHostStub = CodeHostAdapter & {
	readonly changeRequests: readonly ChangeRequestRecord[];
	setCloneUrl(repo: RepoSlug, url: string): void;
	setDefaultBranch(repo: RepoSlug, branch: string): void;
	failNextChangeRequest(error?: Error): void;
};

export function createCodeHostStub(): CodeHostStub {
	const cloneUrls = new Map<RepoSlug, string>();
	const defaultBranches = new Map<RepoSlug, string>();
	const changeRequests: ChangeRequestRecord[] = [];
	let nextChangeRequestError: Error | null = null;

	return {
		get changeRequests() {
			return changeRequests;
		},

		setCloneUrl(repo, url) {
			cloneUrls.set(repo, url);
		},
		setDefaultBranch(repo, branch) {
			defaultBranches.set(repo, branch);
		},
		failNextChangeRequest(
			error = new Error("code host change request failed"),
		) {
			nextChangeRequestError = error;
		},

		cloneUrl(repo) {
			return (
				cloneUrls.get(repo) ?? `https://code-host.example.test/${repo}.git`
			);
		},

		async defaultBranch(repo) {
			return defaultBranches.get(repo) ?? "main";
		},

		async createChangeRequest(repo, head, base, title, body) {
			if (nextChangeRequestError) {
				const e = nextChangeRequestError;
				nextChangeRequestError = null;
				throw e;
			}
			const number = changeRequests.length + 1;
			changeRequests.push({ repo, head, base, title, body });
			return {
				number,
				url: `https://code-host.example.test/${repo}/-/merge_requests/${number}`,
			};
		},
	};
}
