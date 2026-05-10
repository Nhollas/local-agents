import type { RepoSlug } from "../types/brands.ts";

export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	cloneUrl(repo: RepoSlug): string;
	repoUrl(repo: RepoSlug): string;
	defaultBranch(repo: RepoSlug): Promise<string>;
	createChangeRequest(
		repo: RepoSlug,
		head: string,
		base: string,
		title: string,
		body: string,
	): Promise<ChangeRequest>;
};
