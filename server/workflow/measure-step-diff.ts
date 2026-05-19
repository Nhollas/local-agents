import { execFileSync } from "node:child_process";
import { Effect } from "effect";
import { parseShortstat } from "./parse-shortstat.ts";

export function captureHead(cwd: string): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { cwd })
			.toString()
			.trim();
	} catch (err) {
		console.warn(
			`measure_step_diff.head_before_failed cwd=${cwd}: ${formatErr(err)}`,
		);
		return null;
	}
}

export const annotateStepDiff = (
	cwd: string,
	headBefore: string,
): Effect.Effect<void> =>
	Effect.sync(() => readDiff(cwd, headBefore)).pipe(
		Effect.flatMap((diff) =>
			diff
				? Effect.annotateCurrentSpan({
						"step.diff.files_changed": diff.filesChanged,
						"step.diff.lines_added": diff.linesAdded,
						"step.diff.lines_removed": diff.linesRemoved,
					})
				: Effect.void,
		),
	);

function readDiff(
	cwd: string,
	headBefore: string,
): { filesChanged: number; linesAdded: number; linesRemoved: number } | null {
	try {
		const stdout = execFileSync(
			"git",
			["diff", "--shortstat", `${headBefore}..HEAD`],
			{ cwd },
		).toString();
		return parseShortstat(stdout);
	} catch (err) {
		console.warn(`measure_step_diff.diff_failed cwd=${cwd}: ${formatErr(err)}`);
		return null;
	}
}

function formatErr(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
