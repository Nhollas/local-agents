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
