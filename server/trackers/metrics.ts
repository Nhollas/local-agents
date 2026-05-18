import { Metric } from "effect";

export const issuesFetched = Metric.counter(
	"tracker.jira.issues_fetched_total",
	{
		description: "Issues returned by fetchActiveIssues, after scope filtering.",
		incremental: true,
	},
);

export const issuesDropped = Metric.counter(
	"tracker.jira.issues_dropped_total",
	{
		description: "Issues filtered out during fetchActiveIssues, by reason.",
		incremental: true,
	},
);
