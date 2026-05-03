import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { RunHandle, Runner, RunResult } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import {
	type BranchName,
	branchName,
	type RepoSlug,
	type RunId,
} from "../types/brands.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import type { AgentInvoker } from "./agent-invoker.ts";
import { resolveBranch } from "./branch-resolver.ts";
import { renderChangeRequest } from "./change-request-renderer.ts";
import type { Clock } from "./clock.ts";
import { runWorkflowSteps } from "./step-runner.ts";
import {
	ensureBranch,
	ensureWorkspace,
	type RunShell,
	removeWorkspace,
	runRepoSetup,
} from "./workspace.ts";

export type RunRequest = {
	issue: Issue;
	repo: RepoSlug;
	workflow: RepoWorkflow;
	attempt: number;
	resume?: {
		parentRunId: RunId;
		startStepIndex: number;
		sessionId?: string;
	};
};

export type RunLifecycle = {
	dispatch(req: RunRequest): Promise<RunHandle>;
};

type RunLifecycleDeps = {
	runner: Runner;
	repo: RunRepository;
	tracker: TrackerAdapter;
	codeHost: CodeHostAdapter;
	agent: AgentInvoker;
	clock: Clock;
	runShell: RunShell;
	workspaceRoot: string;
	model: string;
	maxRetries: number;
};

export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
	const {
		runner,
		repo: runRepo,
		tracker,
		codeHost,
		agent,
		clock,
		runShell,
		workspaceRoot,
		model,
		maxRetries,
	} = deps;

	async function dispatch(req: RunRequest): Promise<RunHandle> {
		const { issue, repo, workflow, attempt, resume } = req;

		const cloneUrl = codeHost.cloneUrl(repo);
		const ws = await ensureWorkspace(issue, workspaceRoot, cloneUrl);

		return runner.enqueue({
			name: `issue-${issue.number}`,
			repo,
			issueKey: issue.key,
			issueTitle: issue.title,
			attempt,
			...(resume?.parentRunId != null && {
				parentRunId: resume.parentRunId,
				initialOutputs: runRepo.getStepOutputs(resume.parentRunId),
			}),
			handler: (ctx) =>
				canonicalLog.run(
					{
						scope: "run",
						run_id: ctx.runId,
						agent: `issue-${issue.number}`,
						issue_key: issue.key,
						attempt,
					},
					async () => {
						const startTime = clock.now();
						let result: RunResult;
						let branch: BranchName | undefined;

						try {
							const resolvedBranch = await resolveBranch({
								workflowBranch: workflow.branch,
								issue,
								attempt,
								agent,
								cwd: ws.path,
								model,
								signal: ctx.signal,
							});
							branch = branchName(resolvedBranch);

							await ensureBranch(ws.path, branch);
							await runRepoSetup(ws.path, runShell);

							await runWorkflowSteps({
								ctx,
								agent,
								workflow,
								issue,
								attempt,
								branch,
								cwd: ws.path,
								model,
								...(resume?.startStepIndex != null && {
									startStepIndex: resume.startStepIndex,
								}),
								...(resume?.sessionId && {
									failedStepResumeSessionId: resume.sessionId,
								}),
							});

							result = {
								status: "completed",
								durationMs: clock.now() - startTime,
							};
						} catch (err) {
							result = {
								status: "failed",
								error: canonicalLog.errorMessage(err),
								durationMs: clock.now() - startTime,
							};
						}

						canonicalLog.set({
							status: result.status,
							...(result.status === "failed" && { error: result.error }),
						});

						if (result.status === "completed" && branch) {
							await finalizeSuccess(
								repo,
								issue,
								workflow,
								branch,
								attempt,
								ctx.outputs,
							);
						}

						const retriesExhausted = maxRetries - attempt < 0;
						const shouldCleanup =
							result.status === "completed" || retriesExhausted;

						if (shouldCleanup) {
							await removeWorkspace(ws.path);
						}

						if (result.status === "failed" && retriesExhausted) {
							await rollbackTrackerToPending(repo, issue);
						}

						return result;
					},
					logger,
				),
		});
	}

	async function finalizeSuccess(
		repo: RepoSlug,
		issue: Issue,
		workflow: RepoWorkflow,
		branch: BranchName,
		attempt: number,
		outputs: Record<string, unknown>,
	): Promise<void> {
		const { title, body } = renderChangeRequest({
			template: workflow.change_request,
			issue,
			attempt,
			branch,
			outputs,
		});
		try {
			await codeHost.createChangeRequest(
				repo,
				branch,
				branchName(workflow.base_branch),
				title,
				body,
			);
		} catch (err) {
			canonicalLog.append(
				"warnings",
				`on_complete_failed: ${canonicalLog.errorMessage(err)}`,
			);
		}

		await tracker
			.transitionState(repo, issue.number, "running", "awaiting_review")
			.catch((err) =>
				canonicalLog.append(
					"warnings",
					`state_recovery_failed: ${canonicalLog.errorMessage(err)}`,
				),
			);
	}

	async function rollbackTrackerToPending(
		repo: RepoSlug,
		issue: Issue,
	): Promise<void> {
		await tracker
			.transitionState(repo, issue.number, "running", "pending")
			.catch((err) =>
				canonicalLog.append(
					"warnings",
					`state_rollback_failed: ${canonicalLog.errorMessage(err)}`,
				),
			);
	}

	return { dispatch };
}
