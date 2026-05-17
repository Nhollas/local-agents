import { Schema } from "effect";

export const GitHubRepoSchema = Schema.Struct({
	default_branch: Schema.String.pipe(Schema.minLength(1)),
});

export const GitHubPullRequestSchema = Schema.Struct({
	number: Schema.Number,
	html_url: Schema.String,
});

export const GitHubPullRequestsSchema = Schema.Array(GitHubPullRequestSchema);

export const GitLabProjectSchema = Schema.Struct({
	default_branch: Schema.String.pipe(Schema.minLength(1)),
});

export const GitLabMergeRequestSchema = Schema.Struct({
	iid: Schema.Number,
	web_url: Schema.String,
});

export const GitLabMergeRequestsSchema = Schema.Array(GitLabMergeRequestSchema);
