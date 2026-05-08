import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { RunHandle, Runner, RunResult } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { RepoSlug } from "../types/brands.ts";
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
	logger: Logger;
	workspaceRoot: string;
	model: string;
};

type FailurePhase =
	| "branch_resolver"
	| "setup"
	| "step"
	| "push"
	| "change_request"
	| "tracker_transition";

function recordFailure(phase: FailurePhase, error: string): void {
	canonicalLog.set({ failure_phase: phase, failure_error: error });
}

export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
	const {
		runner,
		repo: runRepo,
		tracker,
		codeHost,
		agent,
		clock,
		runShell,
		logger,
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
						workspace_reused: !ws.created,
					},
					async () => {
						const startTime = clock.now();
						let result: RunResult;
						let branch: string | undefined;
						let outputs: Record<string, unknown> = {};
						let phase: FailurePhase = "branch_resolver";

						try {
							const branchResolverStart = clock.now();
							const resolvedBranch = await resolveBranch({
								workflowBranch: workflow.branch,
								issue,
								agent,
								cwd: ws.path,
								model,
								signal: ctx.signal,
							});
							canonicalLog.set({
								branch_resolver_ms: clock.now() - branchResolverStart,
							});
							branch = resolvedBranch;
							canonicalLog.set({ branch });

							phase = "setup";
							await ensureBranch(ws.path, branch);
							const repoSetupRan = await runRepoSetup(ws.path, runShell);
							canonicalLog.set({ repo_setup_ran: repoSetupRan });

							phase = "step";
							outputs = await runWorkflowSteps({
								ctx,
								runRepo,
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
							const error = err instanceof Error ? err.message : String(err);
							recordFailure(phase, error);
							result = {
								status: "failed",
								error,
								durationMs: clock.now() - startTime,
							};
						}

						canonicalLog.set({ status: result.status });

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
								outputs,
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
		branch: string,
		baseBranch: string,
		outputs: Record<string, unknown>,
	): Promise<boolean> {
		// Pinned order per ADR 0001: push → change-request → tracker.
		try {
			await pushBranch(wsPath, branch);
		} catch (err) {
			recordFailure("push", err instanceof Error ? err.message : String(err));
			return false;
		}

		const { title, body } = renderChangeRequest({
			template: workflow.change_request,
			issue,
			branch,
			outputs,
		});
		try {
			const pr = await codeHost.createChangeRequest(
				repo,
				branch,
				baseBranch,
				title,
				body,
			);
			canonicalLog.set({ pr_url: pr.url });
		} catch (err) {
			recordFailure(
				"change_request",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}

		try {
			await tracker.transitionState(
				repo,
				issue.number,
				"running",
				"awaiting_review",
			);
		} catch (err) {
			recordFailure(
				"tracker_transition",
				err instanceof Error ? err.message : String(err),
			);
			return false;
		}
		return true;
	}

	async function markIssueFailed(repo: RepoSlug, issue: Issue): Promise<void> {
		await tracker.markFailed(repo, issue.number).catch((err) => {
			canonicalLog.append("warnings", {
				kind: "mark_failed_failed",
				issue: `${repo}#${issue.number}`,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	return { dispatch };
}
