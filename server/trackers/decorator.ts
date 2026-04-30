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

		async fetchActiveIssues(repo, state) {
			try {
				const issues = await inner.fetchActiveIssues(repo, state);
				canonicalLog.set({
					tracker_active_issues_count: issues.length,
				});
				return issues;
			} catch (err) {
				canonicalLog.append("warnings", `fetch_active_issues_failed: ${repo}`);
				throw err;
			}
		},

		async transitionState(repo, issueNumber, from, to) {
			try {
				await inner.transitionState(repo, issueNumber, from, to);
				canonicalLog.append("state_transitions", { from, to });
			} catch (err) {
				canonicalLog.append(
					"warnings",
					`state_transition_failed: ${repo}#${issueNumber}`,
				);
				throw err;
			}
		},

		parseIssueKey(key) {
			return inner.parseIssueKey(key);
		},
	};
}
