import { gh } from "../gh.ts";
import type { CodeHostAdapter } from "../types.ts";

export function createGitHubCodeHost(): CodeHostAdapter {
	return {
		async fetchFile(
			repo: string,
			path: string,
			ref?: string,
		): Promise<string | null> {
			try {
				const encodedPath = path.split("/").map(encodeURIComponent).join("/");
				const endpoint = ref
					? `repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`
					: `repos/${repo}/contents/${encodedPath}`;
				const stdout = await gh("api", endpoint, "--jq", ".content");
				return Buffer.from(stdout, "base64").toString("utf-8");
			} catch {
				return null;
			}
		},

		cloneUrl(repo: string): string {
			return `https://github.com/${repo}.git`;
		},
	};
}
