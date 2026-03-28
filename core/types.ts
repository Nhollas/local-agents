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

export type ChangeRequest = {
	number: number;
	url: string;
};

export type CodeHostAdapter = {
	fetchFile(repo: string, path: string, ref?: string): Promise<string | null>;
	cloneUrl(repo: string): string;
	createChangeRequest(
		repo: string,
		head: string,
		base: string,
		title: string,
		body: string,
	): Promise<ChangeRequest>;
};

export type Config = {
	tracker: {
		kind: "github";
	};
	code_host: {
		kind: "github";
	};
	repos: string[];
	defaults: {
		polling_interval_ms: number;
		max_concurrent: number;
		max_retries: number;
		model: string;
		workspace_root: string;
	};
};

export type RepoWorkflow = {
	branch: string;
	base_branch: string;
	hooks?: {
		after_create?: string;
		before_run?: string;
		after_run?: string;
	};
	prompt: string;
};
