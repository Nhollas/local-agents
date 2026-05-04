import type { BranchName, RepoSlug } from "../types/brands.ts";

export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	fetchFile(repo: RepoSlug, path: string, ref?: string): Promise<string | null>;
	cloneUrl(repo: RepoSlug): string;
	defaultBranch(repo: RepoSlug): Promise<BranchName>;
	createChangeRequest(
		repo: RepoSlug,
		head: BranchName,
		base: BranchName,
		title: string,
		body: string,
	): Promise<ChangeRequest>;
};
