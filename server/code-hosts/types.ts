import type { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
import type { RepoSlug } from "../types/brands.ts";

export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	cloneUrl(repo: RepoSlug): string;
	repoUrl(repo: RepoSlug): string;
	defaultBranch(repo: RepoSlug): Effect.Effect<string, HttpClientError>;
	createChangeRequest(
		repo: RepoSlug,
		head: string,
		base: string,
		title: string,
		body: string,
	): Effect.Effect<ChangeRequest, HttpClientError>;
};
