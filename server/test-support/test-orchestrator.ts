import { makeCodeHostRuntime } from "../code-hosts/runtime.ts";
import { createOrchestrator } from "../orchestrator/orchestrator.ts";
import { makeOrchestratorRuntime } from "../orchestrator/runtime.ts";
import { createRunRepository } from "../run-repository.ts";
import { createRunner } from "../runner/runner.ts";
import { makeTrackerRuntime } from "../trackers/runtime.ts";
import type { AgentInvokerService } from "../workflow/agent-invoker.ts";
import { makeWorkflowRuntime } from "../workflow/runtime.ts";
import type { RepoWorkflow } from "../workflow/types.ts";
import { createCodeHostStub } from "./code-host-stub.ts";
import {
	adaptRunAgent,
	createTestWorkflow,
	noopAgent,
	REPO,
	type TestRunAgent,
} from "./fixtures.ts";
import { createTestConfig } from "./test-config.ts";
import { createTestDb } from "./test-db.ts";
import { testLogger } from "./test-logger.ts";
import { createTestWorkspaceRoot } from "./test-workspace.ts";
import { createTrackerStub } from "./tracker-stub.ts";

type CreateTestOrchestratorOptions = {
	runAgent?: TestRunAgent;
	agent?: AgentInvokerService;
	configOverrides?: Parameters<typeof createTestConfig>[0];
	workflow?: RepoWorkflow;
	maxConcurrency?: number;
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

	const tracker = createTrackerStub();
	const trackerRuntime = makeTrackerRuntime();
	const codeHost = createCodeHostStub();
	const codeHostRuntime = makeCodeHostRuntime();
	const workflowRuntime = makeWorkflowRuntime();
	const orchestratorRuntime = makeOrchestratorRuntime();

	const defaultBare = await workspace.setupRepoRemote(REPO);
	codeHost.setCloneUrl(REPO, defaultBare);

	const agent = options.agent ?? adaptRunAgent(options.runAgent ?? noopAgent);

	const orchestrator = createOrchestrator({
		runRepo: repo,
		tracker,
		trackerRuntime,
		codeHost,
		codeHostRuntime,
		workflowRuntime,
		orchestratorRuntime,
		config: createTestConfig({
			workspace_root: workspace.root,
			...options.configOverrides,
		}),
		workflow: options.workflow ?? createTestWorkflow(),
		runner,
		agent,
		logger: testLogger,
		langfuse: {
			host: "http://localhost:3100",
			projectId: "test-project-id",
		},
	});

	return {
		orchestrator,
		db,
		repo,
		runner,
		workspace,
		tracker,
		codeHost,
		REPO,
		async [Symbol.asyncDispose]() {
			// Abort any in-flight runs so their orphan handlers don't keep doing
			// work into the next test. The signal.aborted flag is what tells the
			// lifecycle to skip markIssueFailed.
			for (const run of repo.getRunningSnapshot()) {
				runner.kill(run.id);
			}
			await runner.waitForIdle();
			await Promise.all([
				runner.dispose(),
				trackerRuntime.dispose(),
				codeHostRuntime.dispose(),
				workflowRuntime.dispose(),
				orchestratorRuntime.dispose(),
			]);
			await workspace[Symbol.asyncDispose]();
		},
	};
}
