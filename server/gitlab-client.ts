import { z } from "zod";
import { createJsonRequester, type HttpClientOptions } from "./http-client.ts";

const DEFAULT_BASE_URL = "https://gitlab.com";

const gitlabFileSchema = z.object({
	content: z.string(),
});

const gitlabMergeRequestSchema = z.object({
	iid: z.number(),
	web_url: z.string(),
});

export type GitLabClient = {
	getFileContent(
		projectPath: string,
		filePath: string,
		ref?: string,
	): Promise<{ content: string }>;
	listMergeRequests(
		projectPath: string,
		params: { source_branch: string; target_branch: string; state: string },
	): Promise<{ iid: number; web_url: string }[]>;
	createMergeRequest(
		projectPath: string,
		params: {
			source_branch: string;
			target_branch: string;
			title: string;
			description: string;
		},
	): Promise<{ iid: number; web_url: string }>;
};

type GitLabClientOptions = HttpClientOptions & {
	baseUrl?: string;
};

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function encodeProjectPath(projectPath: string): string {
	return encodeURIComponent(projectPath);
}

function encodeFilePath(filePath: string): string {
	return encodeURIComponent(filePath);
}

export function createGitLabClient(
	token: string,
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
		getFileContent(projectPath: string, filePath: string, ref = "HEAD") {
			const query = new URLSearchParams({ ref });
			return request(
				`/projects/${encodeProjectPath(projectPath)}/repository/files/${encodeFilePath(filePath)}?${query}`,
				{ schema: gitlabFileSchema },
			);
		},

		listMergeRequests(
			projectPath: string,
			params: { source_branch: string; target_branch: string; state: string },
		) {
			const query = new URLSearchParams(params);
			return request(
				`/projects/${encodeProjectPath(projectPath)}/merge_requests?${query}`,
				{ schema: z.array(gitlabMergeRequestSchema) },
			);
		},

		createMergeRequest(
			projectPath: string,
			params: {
				source_branch: string;
				target_branch: string;
				title: string;
				description: string;
			},
		) {
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
