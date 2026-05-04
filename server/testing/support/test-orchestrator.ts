import { gitlabCodeHostAdapter } from "../../code-hosts/gitlab.ts";
import type { CodeHostAdapter } from "../../code-hosts/types.ts";
import { createGitLabClient } from "../../gitlab-client.ts";
import { createJiraClient } from "../../jira-client.ts";
import type { AgentInvoker } from "../../orchestrator/agent-invoker.ts";
import { createOrchestrator } from "../../orchestrator/orchestrator.ts";
import { createRunRepository } from "../../run-repository.ts";
import { createRunner } from "../../runner/runner.ts";
import { jiraTrackerAdapter } from "../../trackers/jira.ts";
import type { TrackerAdapter } from "../../trackers/types.ts";
import {
	gitlabToken,
	jiraApiToken,
	jiraEmail,
	type RepoSlug,
} from "../../types/brands.ts";
import type { RepoWorkflow } from "../../workflow/workflow.ts";
import {
	adaptRunAgent,
	createTestWorkflow,
	GITLAB_BASE_URL,
	JIRA_BASE_URL,
	JIRA_PROJECT,
	type LegacyRunAgent,
	noopAgent,
	REPO,
	STATUSES,
	TRIGGER_LABEL,
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
	const runner = createRunner({
		repo,
		maxConcurrency: options.maxConcurrency ?? 2,
	});

	const trackerScopes = options.trackerScopes ?? [REPO];

	const jira = createJiraClient({
		baseUrl: JIRA_BASE_URL,
		email: jiraEmail("agent@example.test"),
		apiToken: jiraApiToken("test-jira-token"),
		maxAttempts: 1,
	});
	const defaultTracker = jiraTrackerAdapter(jira, {
		project: JIRA_PROJECT,
		scopes: trackerScopes,
		baseUrl: JIRA_BASE_URL,
		statuses: { ...STATUSES },
		triggerLabel: TRIGGER_LABEL,
	});

	const gitlabCloneToken = gitlabToken("test-gitlab-token");
	const gitlab = createGitLabClient(gitlabCloneToken, {
		baseUrl: GITLAB_BASE_URL,
		maxAttempts: 1,
	});
	const defaultCodeHost = gitlabCodeHostAdapter(
		gitlab,
		GITLAB_BASE_URL,
		gitlabCloneToken,
	);

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
