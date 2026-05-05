import * as canonicalLog from "../canonical-log.ts";
import type { TrackerAdapter } from "./types.ts";

/**
 * Wrap a tracker so any thrown error is appended as a structured entry to the
 * canonical-log `warnings` array before being re-thrown. Callers can therefore
 * use bare `.catch(() => {})` swallow blocks where appropriate.
 */
export function decorateTracker(inner: TrackerAdapter): TrackerAdapter {
	return {
		...inner,
		fetchActiveIssues: (state) =>
			withWarning("fetch_active_issues_failed", { state }, () =>
				inner.fetchActiveIssues(state),
			),
		transitionState: (repo, issueNumber, from, to) =>
			withWarning(
				"state_transition_failed",
				{ issue: `${repo}#${issueNumber}`, from, to },
				() => inner.transitionState(repo, issueNumber, from, to),
			),
		markFailed: (repo, issueNumber) =>
			withWarning(
				"mark_failed_failed",
				{ issue: `${repo}#${issueNumber}` },
				() => inner.markFailed(repo, issueNumber),
			),
	};
}

async function withWarning<T>(
	kind: string,
	context: Record<string, unknown>,
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		canonicalLog.append("warnings", {
			kind,
			...context,
			error: canonicalLog.errorMessage(err),
		});
		throw err;
	}
}
