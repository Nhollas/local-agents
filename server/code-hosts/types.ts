import type { Effect } from "effect";
import type { RepoSlug } from "../types/brands.ts";
import type { CodeHostError } from "./errors.ts";

export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	cloneUrl(repo: RepoSlug): string;
	repoUrl(repo: RepoSlug): string;
	defaultBranch(repo: RepoSlug): Effect.Effect<string, CodeHostError>;
	createChangeRequest(
		repo: RepoSlug,
		head: string,
		base: string,
		title: string,
		body: string,
	): Effect.Effect<ChangeRequest, CodeHostError>;
};
