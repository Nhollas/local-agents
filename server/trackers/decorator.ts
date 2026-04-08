import * as canonicalLog from "../canonical-log.ts";
import type { TrackerAdapter } from "./types.ts";

export function decorateTracker(inner: TrackerAdapter): TrackerAdapter {
	return {
		async fetchIssue(repo, issueNumber) {
			try {
				const issue = await inner.fetchIssue(repo, issueNumber);
				canonicalLog.set({ tracker_fetch_issue: `${repo}#${issueNumber}` });
				return issue;
			} catch (err) {
				canonicalLog.set({
					tracker_error: `fetch_issue_failed: ${repo}#${issueNumber}`,
				});
				throw err;
			}
		},

		async fetchActiveIssues(repo, label) {
			try {
				const issues = await inner.fetchActiveIssues(repo, label);
				canonicalLog.set({
					tracker_active_issues_count: issues.length,
				});
				return issues;
			} catch (err) {
				canonicalLog.append("warnings", `fetch_active_issues_failed: ${repo}`);
				throw err;
			}
		},

		async swapLabel(repo, issueNumber, remove, add) {
			try {
				await inner.swapLabel(repo, issueNumber, remove, add);
				canonicalLog.append("label_swaps", { from: remove, to: add });
			} catch (err) {
				canonicalLog.append(
					"warnings",
					`label_swap_failed: ${repo}#${issueNumber}`,
				);
				throw err;
			}
		},
	};
}
