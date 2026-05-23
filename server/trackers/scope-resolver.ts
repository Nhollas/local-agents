export function resolveRepo(
	path: string,
	scopes: readonly string[],
): string | null {
	for (const scope of scopes) {
		if (path === scope || path.startsWith(`${scope}/`)) return path;
	}
	return null;
}
