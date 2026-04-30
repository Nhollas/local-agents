export type Issue = {
	key: string; // "nhollas/target-dummy#42"
	number: number;
	title: string;
	description: string;
	labels: string[];
	url: string;
	createdAt: string; // ISO 8601
};

export type TrackerState = "pending" | "running" | "awaiting_review";

export type TrackerAdapter = {
	fetchIssue(repo: string, issueNumber: number): Promise<Issue>;
	fetchActiveIssues(repo: string, state: TrackerState): Promise<Issue[]>;
	transitionState(
		repo: string,
		issueNumber: number,
		from: TrackerState,
		to: TrackerState,
	): Promise<void>;
	parseIssueKey(key: string): { repo: string; number: number };
};
