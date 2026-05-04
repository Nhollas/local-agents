import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "./http-client.ts";
import type { BranchName, GitLabToken, RepoSlug } from "./types/brands.ts";

const gitlabFileSchema = z.object({
	content: z.string(),
});

const gitlabMergeRequestSchema = z.object({
	iid: z.number(),
	web_url: z.string(),
});

export type GitLabClient = {
	getFileContent(
		projectPath: RepoSlug,
		filePath: string,
		ref?: string,
	): Promise<{ content: string }>;
	listMergeRequests(
		projectPath: RepoSlug,
		params: {
			source_branch: BranchName;
			target_branch: BranchName;
			state: string;
		},
	): Promise<{ iid: number; web_url: string }[]>;
	createMergeRequest(
		projectPath: RepoSlug,
		params: {
			source_branch: BranchName;
			target_branch: BranchName;
			title: string;
			description: string;
		},
	): Promise<{ iid: number; web_url: string }>;
};

type GitLabClientOptions = HttpClientOptions & {
	baseUrl?: string;
};

export function createGitLabClient(
	token: GitLabToken,
	options: GitLabClientOptions = {},
): GitLabClient {
	const baseUrl = trimTrailingSlash(options.baseUrl ?? DEFAULT_BASE_URL);
	const request = createJsonRequester({
		...options,
		baseUrl: `${baseUrl}/api/v4`,
		serviceName: "GitLab",
		headers: {
			"PRIVATE-TOKEN": token,
		},
	});

	return {
		getFileContent(projectPath, filePath, ref = "HEAD") {
			const query = new URLSearchParams({ ref });
			return request(
				`/projects/${encodeProjectPath(projectPath)}/repository/files/${encodeFilePath(filePath)}?${query}`,
				{ schema: gitlabFileSchema },
			);
		},

		listMergeRequests(projectPath, params) {
			const query = new URLSearchParams(params);
			return request(
				`/projects/${encodeProjectPath(projectPath)}/merge_requests?${query}`,
				{ schema: z.array(gitlabMergeRequestSchema) },
			);
		},

		createMergeRequest(projectPath, params) {
			return request(
				`/projects/${encodeProjectPath(projectPath)}/merge_requests`,
				{
					method: "POST",
					body: params,
					schema: gitlabMergeRequestSchema,
				},
			);
		},
	};
}

const DEFAULT_BASE_URL = "https://gitlab.com";

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function encodeProjectPath(projectPath: RepoSlug): string {
	return encodeURIComponent(projectPath);
}

function encodeFilePath(filePath: string): string {
	return encodeURIComponent(filePath);
}
