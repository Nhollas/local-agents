import { githubCodeHostAdapter } from "../../code-hosts/github.ts";
import type { CodeHostAdapter } from "../../code-hosts/types.ts";
import { createGitHubClient } from "../../github-client.ts";
import type { AgentInvoker } from "../../orchestrator/agent-invoker.ts";
import { createOrchestrator } from "../../orchestrator/orchestrator.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import { githubTrackerAdapter } from "../../trackers/github.ts";
import type { TrackerAdapter } from "../../trackers/types.ts";
import { githubToken, type RepoSlug } from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import type { LegacyRunAgent } from "./fixtures.ts";
import {
	adaptRunAgent,
	createTestWorkflow,
	noopAgent,
	REPO,
} from "./fixtures.ts";
import { createTestConfig } from "./test-config.ts";
import { createTestDb } from "./test-db.ts";
import { createTestWorkspaceRoot } from "./test-workspace.ts";

type CreateTestOrchestratorOptions = {
	runAgent?: LegacyRunAgent;
	agent?: AgentInvoker;
	configOverrides?: Parameters<typeof createTestConfig>[0];
	workflow?: RepoWorkflow;
	trackerScopes?: readonly RepoSlug[];
	maxConcurrency?: number;
	codeHost?: (defaults: CodeHostAdapter) => CodeHostAdapter;
	tracker?: (defaults: TrackerAdapter) => TrackerAdapter;
};

export async function createTestOrchestrator(
	options: CreateTestOrchestratorOptions = {},
) {
	const workspace = await createTestWorkspaceRoot();
	const db = createTestDb();
	const repo = createRunRepository(db);
	const github = createGitHubClient(githubToken("test-token"), {
		maxAttempts: 1,
	});
	const runner = createRunner({
		repo,
		maxConcurrency: options.maxConcurrency ?? 2,
	});

	const defaultCodeHost = githubCodeHostAdapter(github);
	const trackerScopes = options.trackerScopes ?? [REPO];
	const defaultTracker = githubTrackerAdapter(github, {
		scopes: trackerScopes,
		triggerLabel: "agent",
	});

	const agent = options.agent ?? adaptRunAgent(options.runAgent ?? noopAgent);

	const orchestrator = createOrchestrator({
		runRepo: repo,
		tracker: options.tracker ? options.tracker(defaultTracker) : defaultTracker,
		codeHost: options.codeHost
			? options.codeHost(defaultCodeHost)
			: defaultCodeHost,
		config: createTestConfig({
			workspace_root: workspace.root,
			...options.configOverrides,
		}),
		workflow: options.workflow ?? createTestWorkflow(),
		runner,
		agent,
	});

	return {
		orchestrator,
		db,
		repo,
		runner,
		workspace,
		async [Symbol.asyncDispose]() {
			// Abort any in-flight runs so their orphan handlers don't keep doing
			// work (git, MSW POSTs) into the next test. The signal.aborted flag
			// is what tells the lifecycle to skip markIssueFailed.
			for (const run of repo.getRunningSnapshot()) {
				runner.kill(run.id);
			}
			await runner.queue.waitForIdle();
			await workspace[Symbol.asyncDispose]();
		},
	};
}
