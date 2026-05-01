import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import { logger } from "../logger.ts";
import type { RunHandle, Runner, RunResult } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import { branchName, type RepoSlug, type RunId } from "../types/brands.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import type { AgentInvoker } from "./agent-invoker.ts";
import type { Clock } from "./clock.ts";
import { runWorkflowPhases } from "./phase-runner.ts";
import {
	ensureWorkspace,
	type RunShell,
	removeWorkspace,
} from "./workspace.ts";

export type RunRequest = {
	issue: Issue;
	repo: RepoSlug;
	workflow: RepoWorkflow;
	attempt: number;
	resume?: {
		parentRunId: RunId;
		startPhaseIndex: number;
		sessionId?: string;
	};
};

export type RunLifecycle = {
	dispatch(req: RunRequest): Promise<RunHandle>;
};

type RunLifecycleDeps = {
	runner: Runner;
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
		const ws = await ensureWorkspace(
			issue,
			workspaceRoot,
			cloneUrl,
			workflow.hooks,
			runShell,
		);

		if (workflow.hooks?.before_run) {
			const script = renderPrompt(workflow.hooks.before_run, {
				issue,
				attempt,
			});
			await runShell(script, ws.path);
		}

		return runner.enqueue({
			name: `issue-${issue.number}`,
			issueKey: issue.key,
			issueTitle: issue.title,
			attempt,
			...(resume?.parentRunId != null && { parentRunId: resume.parentRunId }),
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

						try {
							await runWorkflowPhases({
								ctx,
								agent,
								workflow,
								issue,
								attempt,
								cwd: ws.path,
								model,
								...(resume?.startPhaseIndex != null && {
									startPhaseIndex: resume.startPhaseIndex,
								}),
								...(resume?.sessionId && {
									failedPhaseResumeSessionId: resume.sessionId,
								}),
							});

							if (workflow.hooks?.after_run) {
								const script = renderPrompt(workflow.hooks.after_run, {
									issue,
									attempt,
								});
								try {
									await runShell(script, ws.path);
								} catch (err) {
									canonicalLog.append(
										"warnings",
										`after_run_failed: ${canonicalLog.errorMessage(err)}`,
									);
								}
							}

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

						if (result.status === "completed") {
							await finalizeSuccess(repo, issue, workflow);
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
	): Promise<void> {
		try {
			const head = branchName(renderPrompt(workflow.branch, { issue }));
			await codeHost.createChangeRequest(
				repo,
				head,
				branchName(workflow.base_branch),
				issue.title,
				`Closes ${issue.key}`,
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
