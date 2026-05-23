import type { Effect } from "effect";
import type { HttpClientError } from "../http/errors.ts";
export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	cloneUrl(repo: string): string;
	repoUrl(repo: string): string;
	defaultBranch(repo: string): Effect.Effect<string, HttpClientError>;
	createChangeRequest(
		repo: string,
		head: string,
		base: string,
		title: string,
		body: string,
	): Effect.Effect<ChangeRequest, HttpClientError>;
};
