import { makeCodeHostRuntime } from "../code-hosts/runtime.ts";
import type { AgentInvoker } from "../orchestrator/agent-invoker.ts";
import { createOrchestrator } from "../orchestrator/orchestrator.ts";
import { createRunRepository } from "../run-repository.ts";
import { createRunner } from "../runner/runner.ts";
import { makeTrackerRuntime } from "../trackers/runtime.ts";
import { makeWorkflowRuntime } from "../workflow/runtime.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
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
	agent?: AgentInvoker;
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
		config: createTestConfig({
			workspace_root: workspace.root,
			...options.configOverrides,
		}),
		workflow: options.workflow ?? createTestWorkflow(),
		runner,
		agent,
		logger: testLogger,
		langfuse: {
			publicKey: "test-public-key",
			secretKey: "test-secret-key",
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
			]);
			await workspace[Symbol.asyncDispose]();
		},
	};
}
