export type Issue = {
	key: string; // "nhollas/target-dummy#42"
	number: number;
	title: string;
	description: string;
	labels: string[];
	url: string;
	createdAt: string; // ISO 8601
};

export type TrackerAdapter = {
	fetchActiveIssues(repo: string, label: string): Promise<Issue[]>;
	swapLabel(
		repo: string,
		issueNumber: number,
		remove: string,
		add: string,
	): Promise<void>;
};
