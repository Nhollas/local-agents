import { type RepoSlug, repoSlug } from "./types/brands.ts";

export function resolveRepo(
	path: string,
	scopes: readonly string[],
): RepoSlug | null {
	for (const scope of scopes) {
		if (path === scope || path.startsWith(`${scope}/`)) return repoSlug(path);
	}
	return null;
}
