export function parseShortstat(output: string): {
	filesChanged: number;
	linesAdded: number;
	linesRemoved: number;
} {
	const num = (re: RegExp): number => {
		const m = re.exec(output);
		return m?.[1] != null ? parseInt(m[1], 10) : 0;
	};
	return {
		filesChanged: num(/(\d+) files? changed/),
		linesAdded: num(/(\d+) insertions?\(\+\)/),
		linesRemoved: num(/(\d+) deletions?\(-\)/),
	};
}
