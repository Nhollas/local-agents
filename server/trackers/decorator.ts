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

		async fetchActiveIssues(state) {
			try {
				const page = await inner.fetchActiveIssues(state);
				canonicalLog.set({
					tracker_active_issues_count: page.issues.length,
				});
				return page;
			} catch (err) {
				canonicalLog.append("warnings", `fetch_active_issues_failed: ${state}`);
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

		async markFailed(repo, issueNumber) {
			try {
				await inner.markFailed(repo, issueNumber);
				canonicalLog.append("state_transitions", { to: "failed" });
			} catch (err) {
				canonicalLog.append(
					"warnings",
					`mark_failed_failed: ${repo}#${issueNumber}`,
				);
				throw err;
			}
		},

		parseIssueKey(key) {
			return inner.parseIssueKey(key);
		},
	};
}
