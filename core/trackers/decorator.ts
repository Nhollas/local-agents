import { logger } from "../logger.ts";
import type { TrackerAdapter } from "../types.ts";

export function decorateTracker(inner: TrackerAdapter): TrackerAdapter {
	return {
		async fetchActiveIssues(repo, label) {
			try {
				const issues = await inner.fetchActiveIssues(repo, label);
				logger.info(
					{ repo, label, count: issues.length },
					"tracker.fetch_active_issues",
				);
				return issues;
			} catch (err) {
				logger.warn({ repo, label, err }, "tracker.fetch_active_issues_failed");
				throw err;
			}
		},

		async swapLabel(repo, issueNumber, remove, add) {
			try {
				await inner.swapLabel(repo, issueNumber, remove, add);
				logger.info(
					{ repo, issueNumber, from: remove, to: add },
					"tracker.label_swapped",
				);
			} catch (err) {
				logger.warn(
					{ repo, issueNumber, from: remove, to: add, err },
					"tracker.label_swap_failed",
				);
				throw err;
			}
		},
	};
}
