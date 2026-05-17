import { Effect } from "effect";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import { HttpServiceError } from "../http/errors.ts";
import type { RepoSlug } from "../types/brands.ts";

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
	failNextChangeRequest(error?: HttpServiceError): void;
};

export function createCodeHostStub(): CodeHostStub {
	const cloneUrls = new Map<RepoSlug, string>();
	const defaultBranches = new Map<RepoSlug, string>();
	const changeRequests: ChangeRequestRecord[] = [];
	let nextChangeRequestError: HttpServiceError | null = null;

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
			error = new HttpServiceError({
				service: "stub",
				message: "code host change request failed",
				method: "POST",
				url: "https://code-host.example.test/stub",
			}),
		) {
			nextChangeRequestError = error;
		},

		cloneUrl(repo) {
			return (
				cloneUrls.get(repo) ?? `https://code-host.example.test/${repo}.git`
			);
		},

		repoUrl(repo) {
			return `https://code-host.example.test/${repo}`;
		},

		defaultBranch(repo) {
			return Effect.succeed(defaultBranches.get(repo) ?? "main");
		},

		createChangeRequest(repo, head, base, title, body) {
			return Effect.suspend(() => {
				if (nextChangeRequestError) {
					const e = nextChangeRequestError;
					nextChangeRequestError = null;
					return Effect.fail(e);
				}
				const number = changeRequests.length + 1;
				changeRequests.push({ repo, head, base, title, body });
				return Effect.succeed({
					number,
					url: `https://code-host.example.test/${repo}/-/merge_requests/${number}`,
				});
			});
		},
	};
}
