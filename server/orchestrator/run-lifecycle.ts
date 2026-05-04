import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { RunHandle, Runner, RunResult } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import { type BranchName, branchName, type RepoSlug } from "../types/brands.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import type { AgentInvoker } from "./agent-invoker.ts";
import { resolveBranch } from "./branch-resolver.ts";
import { renderChangeRequest } from "./change-request-renderer.ts";
import type { Clock } from "./clock.ts";
import { runWorkflowSteps } from "./step-runner.ts";
import {
	ensureBranch,
	ensureWorkspace,
	pushBranch,
	type RunShell,
	removeWorkspace,
	runRepoSetup,
} from "./workspace.ts";

type RunRequest = {
	issue: Issue;
	repo: RepoSlug;
	workflow: RepoWorkflow;
};

type RunLifecycle = {
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
};

export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
	const {
		runner,
		tracker,
		codeHost,
		agent,
		clock,
		runShell,
		workspaceRoot,
		model,
	} = deps;

	async function dispatch(req: RunRequest): Promise<RunHandle> {
		const { issue, repo, workflow } = req;

		const cloneUrl = codeHost.cloneUrl(repo);
		const baseBranch = await codeHost.defaultBranch(repo);
		const ws = await ensureWorkspace(issue, workspaceRoot, cloneUrl);

		return runner.enqueue({
			name: `issue-${issue.number}`,
			repo,
			issueKey: issue.key,
			issueTitle: issue.title,
			handler: (ctx) =>
				canonicalLog.run(
					{
						scope: "run",
						run_id: ctx.runId,
						agent: `issue-${issue.number}`,
						issue_key: issue.key,
					},
					async () => {
						const startTime = clock.now();
						let result: RunResult;
						let branch: BranchName | undefined;

						try {
							const resolvedBranch = await resolveBranch({
								workflowBranch: workflow.branch,
								issue,
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
								branch,
								baseBranch,
								cwd: ws.path,
								model,
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

						const succeeded =
							result.status === "completed" &&
							branch !== undefined &&
							(await finalizeSuccess(
								repo,
								issue,
								workflow,
								ws.path,
								branch,
								baseBranch,
								ctx.outputs,
							));

						// Keep the workspace on any failure so the run can be inspected;
						// only fully successful runs (agent + push + change-request) clean up.
						if (succeeded) {
							await removeWorkspace(ws.path);
						} else if (!ctx.signal.aborted) {
							await markIssueFailed(repo, issue);
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
		wsPath: string,
		branch: BranchName,
		baseBranch: BranchName,
		outputs: Record<string, unknown>,
	): Promise<boolean> {
		// Pinned order per ADR 0001: push → change-request → tracker.
		try {
			await pushBranch(wsPath, branch);
		} catch (err) {
			canonicalLog.append(
				"warnings",
				`push_failed: ${canonicalLog.errorMessage(err)}`,
			);
			return false;
		}

		const { title, body } = renderChangeRequest({
			template: workflow.change_request,
			issue,
			branch,
			outputs,
		});
		try {
			await codeHost.createChangeRequest(repo, branch, baseBranch, title, body);
		} catch (err) {
			canonicalLog.append(
				"warnings",
				`on_complete_failed: ${canonicalLog.errorMessage(err)}`,
			);
			return false;
		}

		await tracker
			.transitionState(repo, issue.number, "running", "awaiting_review")
			.catch((err) =>
				canonicalLog.append(
					"warnings",
					`state_recovery_failed: ${canonicalLog.errorMessage(err)}`,
				),
			);
		return true;
	}

	async function markIssueFailed(repo: RepoSlug, issue: Issue): Promise<void> {
		await tracker
			.markFailed(repo, issue.number)
			.catch((err) =>
				canonicalLog.append(
					"warnings",
					`mark_failed_failed: ${canonicalLog.errorMessage(err)}`,
				),
			);
	}

	return { dispatch };
}
