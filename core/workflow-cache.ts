import { logger } from "./logger.ts";
import type { CodeHostAdapter, RepoWorkflow } from "./types.ts";
import { parseRepoWorkflow } from "./workflow.ts";

const WORKFLOW_PATH = ".agents/workflow.yaml";
const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

type WorkflowCache = {
	workflows: Map<string, RepoWorkflow>;
	refresh(): Promise<void>;
	start(): void;
	stop(): void;
};

export function createWorkflowCache(
	codeHost: CodeHostAdapter,
	repos: string[],
): WorkflowCache {
	const workflows = new Map<string, RepoWorkflow>();
	let timer: ReturnType<typeof setInterval>;

	async function fetchWorkflow(repo: string): Promise<RepoWorkflow | null> {
		const content = await codeHost.fetchFile(repo, WORKFLOW_PATH);
		if (content === null) return null;
		return parseRepoWorkflow(content);
	}

	async function refresh(): Promise<void> {
		const results = await Promise.allSettled(
			repos.map(async (repo) => {
				const workflow = await fetchWorkflow(repo);
				return { repo, workflow };
			}),
		);

		for (const result of results) {
			if (result.status === "fulfilled") {
				const { repo, workflow } = result.value;
				if (workflow) {
					workflows.set(repo, workflow);
				}
			} else {
				const err = result.reason;
				logger.warn(
					{ err },
					"workflow-cache.refresh_failed, keeping last-known-good",
				);
			}
		}
	}

	return {
		workflows,
		refresh,
		start() {
			timer = setInterval(
				() =>
					refresh().catch((err) =>
						logger.error({ err }, "workflow-cache.refresh_error"),
					),
				REFRESH_INTERVAL_MS,
			);
		},
		stop() {
			clearInterval(timer);
		},
	};
}
