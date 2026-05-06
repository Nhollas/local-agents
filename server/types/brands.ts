declare const brand: unique symbol;

export type Brand<T, Name extends string> = T & {
	readonly [brand]: Name;
};

export type RepoSlug = Brand<string, "RepoSlug">;
export const repoSlug = (value: string): RepoSlug => value as RepoSlug;

export type IssueKey = Brand<string, "IssueKey">;
export const issueKey = (value: string): IssueKey => value as IssueKey;

export type IssueNumber = Brand<number, "IssueNumber">;
export const issueNumber = (value: number): IssueNumber => value as IssueNumber;

export type BranchName = Brand<string, "BranchName">;
export const branchName = (value: string): BranchName => value as BranchName;

export type RunId = Brand<string, "RunId">;
export const runId = (value: string): RunId => value as RunId;

export type GitLabToken = Brand<string, "GitLabToken">;
export const gitlabToken = (value: string): GitLabToken => value as GitLabToken;

export type GitHubToken = Brand<string, "GitHubToken">;
export const githubToken = (value: string): GitHubToken => value as GitHubToken;

export type JiraApiToken = Brand<string, "JiraApiToken">;
export const jiraApiToken = (value: string): JiraApiToken =>
	value as JiraApiToken;

export type JiraEmail = Brand<string, "JiraEmail">;
export const jiraEmail = (value: string): JiraEmail => value as JiraEmail;
