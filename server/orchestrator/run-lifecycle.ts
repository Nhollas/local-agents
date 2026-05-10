import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { FinalizeFailurePhase } from "../db/schema.ts";
import type { Logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type {
	RunContext,
	RunHandle,
	Runner,
	RunResult,
} from "../runner/runner.ts";
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

type FailurePhase = "branch_resolver" | "setup" | "step" | FinalizeFailurePhase;

type FinalizeOutcome =
	| { ok: true }
	| { ok: false; phase: FinalizeFailurePhase; error: string };

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
			repo,
			repoUrl: codeHost.repoUrl(repo),
			issueKey: issue.key,
			issueTitle: issue.title,
			issueUrl: issue.url,
			handler: (ctx) =>
				canonicalLog.run(
					{
						scope: "run",
						run_id: ctx.runId,
						issue_key: issue.key,
						workspace_reused: !ws.created,
					},
					async () => {
						const startTime = clock.now();
						let result: RunResult;
						let branch: string | undefined;
						let outputs: Record<string, unknown> = {};
						let phase: FailurePhase = "branch_resolver";

						runRepo.setRunWorkspaceDir(ctx.runId, ws.path);
						runRepo.insertSteps(
							ctx.runId,
							workflow.steps.map((s, i) => ({ index: i + 1, name: s.name })),
						);
						ctx.emit({
							kind: "system",
							stepName: null,
							data: {
								message: "workspace prepared",
								command: null,
								path: ws.path,
								exitCode: null,
							},
						});

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
							runRepo.setRunBranch(ctx.runId, branch);
							ctx.emit({
								kind: "system",
								stepName: null,
								data: {
									message: "branch resolved",
									command: null,
									path: branch,
									exitCode: null,
								},
							});

							phase = "setup";
							await ensureBranch(ws.path, branch);
							const repoSetupRan = await runRepoSetup(ws.path, runShell);
							canonicalLog.set({ repo_setup_ran: repoSetupRan });
							if (repoSetupRan) {
								ctx.emit({
									kind: "system",
									stepName: null,
									data: {
										message: "repo setup ran",
										command: ".agent/setup.sh",
										path: ws.path,
										exitCode: 0,
									},
								});
							}

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

						if (result.status === "completed" && branch !== undefined) {
							const finalize = await finalizeSuccess(
								ctx,
								repo,
								issue,
								workflow,
								ws.path,
								branch,
								baseBranch,
								outputs,
							);
							if (!finalize.ok) {
								ctx.emit({
									kind: "system",
									stepName: null,
									data: {
										message: `finalize failed: ${finalize.phase}`,
										command: null,
										path: null,
										exitCode: null,
									},
								});
								result = {
									status: "failed",
									error: `${finalize.phase}: ${finalize.error}`,
									durationMs: result.durationMs,
									finalizeFailure: {
										phase: finalize.phase,
										error: finalize.error,
									},
								};
							}
						}

						canonicalLog.set({ status: result.status });

						// Keep the workspace on any failure so the run can be inspected;
						// only fully successful runs (agent + push + change-request) clean up.
						if (result.status === "completed") {
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
		ctx: RunContext,
		repo: RepoSlug,
		issue: Issue,
		workflow: RepoWorkflow,
		wsPath: string,
		branch: string,
		baseBranch: string,
		outputs: Record<string, unknown>,
	): Promise<FinalizeOutcome> {
		// Pinned order per ADR 0001: push → change-request → tracker.
		try {
			await pushBranch(wsPath, branch);
		} catch (err) {
			return finalizeFailure("push", err);
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
			runRepo.setRunPr(ctx.runId, {
				repo,
				number: pr.number,
				url: pr.url,
				kind: "opened",
			});
			canonicalLog.set({ pr_url: pr.url });
			ctx.emit({
				kind: "system",
				stepName: null,
				data: {
					message: "change request opened",
					command: null,
					path: pr.url,
					exitCode: null,
				},
			});
		} catch (err) {
			return finalizeFailure("change_request", err);
		}

		try {
			await tracker.transitionState(
				repo,
				issue.number,
				"running",
				"awaiting_review",
			);
		} catch (err) {
			return finalizeFailure("tracker_transition", err);
		}
		return { ok: true };
	}

	function finalizeFailure(
		phase: FinalizeFailurePhase,
		err: unknown,
	): FinalizeOutcome {
		const error = err instanceof Error ? err.message : String(err);
		recordFailure(phase, error);
		return { ok: false, phase, error };
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
