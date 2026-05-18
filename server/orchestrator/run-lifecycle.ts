import { Cause, type Effect, Exit, Option } from "effect";
import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostRuntime } from "../code-hosts/runtime.ts";
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
import { runRunSpan } from "../telemetry/spans.ts";
import type { TrackerRuntime } from "../trackers/runtime.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { RepoSlug } from "../types/brands.ts";
import type { AgentInvokerService } from "../workflow/agent-invoker.ts";
import type { WorkflowRuntime } from "../workflow/runtime.ts";
import type { RepoWorkflow } from "../workflow/types.ts";
import { resolveBranch } from "./branch-resolver.ts";
import { renderChangeRequest } from "./change-request-renderer.ts";
import type { Clock } from "./clock.ts";
import type { OrchestratorRuntime } from "./runtime.ts";
import { runWorkflowSteps } from "./step-runner.ts";
import {
	createWorkspace,
	ensureBranch,
	installSkills,
	pushBranch,
	removeWorkspace,
	resolveWorkspaceEnvironment,
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
	trackerRuntime: TrackerRuntime;
	codeHost: CodeHostAdapter;
	codeHostRuntime: CodeHostRuntime;
	workflowRuntime: WorkflowRuntime;
	orchestratorRuntime: OrchestratorRuntime;
	agent: AgentInvokerService;
	clock: Clock;
	logger: Logger;
	workspaceRoot: string;
	skillsSourceDir: string;
	agentEnv: Record<string, string>;
	langfuseHost: string;
	langfuseProjectId: string;
};

type FailurePhase =
	| "workspace"
	| "branch_resolver"
	| "skills"
	| "setup"
	| "step"
	| FinalizeFailurePhase;

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
		trackerRuntime,
		codeHost,
		codeHostRuntime,
		workflowRuntime,
		orchestratorRuntime,
		agent,
		clock,
		logger,
		workspaceRoot,
		skillsSourceDir,
		agentEnv,
		langfuseHost,
		langfuseProjectId,
	} = deps;

	type OrchR = Parameters<typeof orchestratorRuntime.runPromise>[0] extends
		| Effect.Effect<unknown, unknown, infer R>
		| infer _
		? R
		: never;
	async function runOrch<A, E>(eff: Effect.Effect<A, E, OrchR>): Promise<A> {
		const exit = await orchestratorRuntime.runPromiseExit(eff);
		if (Exit.isSuccess(exit)) return exit.value;
		const failure = Cause.failureOption(exit.cause);
		if (Option.isSome(failure)) throw failure.value;
		throw Cause.squash(exit.cause);
	}

	async function dispatch(req: RunRequest): Promise<RunHandle> {
		const { issue, repo, workflow } = req;

		const cloneUrl = codeHost.cloneUrl(repo);
		const baseBranch = await codeHostRuntime.runPromise(
			codeHost.defaultBranch(repo),
		);

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
					},
					() =>
						runRunSpan(
							{
								runId: ctx.runId,
								issueKey: issue.key,
								issueTitle: issue.title,
								issueUrl: issue.url,
								repo,
							},
							async (traceId) => {
								const langfuseTraceUrl = `${langfuseHost}/project/${langfuseProjectId}/traces/${traceId}`;
								runRepo.setRunLangfuseTraceUrl(ctx.runId, langfuseTraceUrl);
								try {
									const startTime = clock.now();
									let result: RunResult;
									let branch: string | undefined;
									let outputs: Record<string, unknown> = {};
									let phase: FailurePhase = "branch_resolver";

									runRepo.insertSteps(
										ctx.runId,
										workflow.steps.map((s, i) => ({
											index: i + 1,
											name: s.name,
										})),
									);

									let wsPath: string;
									try {
										wsPath = await runOrch(
											createWorkspace(
												issue,
												workspaceRoot,
												cloneUrl,
												ctx.runId,
											),
										);
									} catch (err) {
										const error =
											err instanceof Error ? err.message : String(err);
										recordFailure("workspace", error);
										canonicalLog.set({ status: "failed" });
										await markIssueFailed(repo, issue);
										return {
											status: "failed",
											error,
											durationMs: clock.now() - startTime,
										};
									}

									runRepo.setRunWorkspaceDir(ctx.runId, wsPath);
									ctx.emit({
										kind: "system",
										stepName: null,
										data: {
											message: "workspace prepared",
											command: null,
											path: wsPath,
											exitCode: null,
										},
									});

									try {
										const branchResolverStart = clock.now();
										const resolvedBranch = await resolveBranch({
											workflowBranch: workflow.branch,
											issue,
											agent,
											runRepo,
											cwd: wsPath,
											runId: ctx.runId,
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

										await runOrch(ensureBranch(wsPath, branch));

										phase = "skills";
										const skillsResult = await runOrch(
											installSkills(wsPath, skillsSourceDir, {
												issue,
												branch,
												base_branch: baseBranch,
											}),
										);
										canonicalLog.set({
											skills_installed: skillsResult.installed,
											skills_skipped: skillsResult.skipped,
										});
										if (
											skillsResult.installed.length > 0 ||
											skillsResult.skipped.length > 0
										) {
											ctx.emit({
												kind: "system",
												stepName: null,
												data: {
													message: `skills installed: ${skillsResult.installed.length} (skipped ${skillsResult.skipped.length})`,
													command: null,
													path: null,
													exitCode: null,
												},
											});
										}

										phase = "setup";
										const workspaceEnv = await runOrch(
											resolveWorkspaceEnvironment(wsPath, agentEnv),
										);
										const repoSetupRan = await runOrch(
											runRepoSetup(wsPath, workspaceEnv),
										);
										canonicalLog.set({ repo_setup_ran: repoSetupRan });
										if (repoSetupRan) {
											ctx.emit({
												kind: "system",
												stepName: null,
												data: {
													message: "repo setup ran",
													command: ".agent/setup.sh",
													path: wsPath,
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
											cwd: wsPath,
											env: workspaceEnv,
											logger,
											workflowRuntime,
										});

										result = {
											status: "completed",
											durationMs: clock.now() - startTime,
										};
									} catch (err) {
										const error =
											err instanceof Error ? err.message : String(err);
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
											wsPath,
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
										await runOrch(removeWorkspace(wsPath));
									} else {
										await markIssueFailed(repo, issue);
									}

									return result;
								} finally {
									logger.info(`langfuse trace: ${langfuseTraceUrl}`);
								}
							},
						),
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
			await runOrch(pushBranch(wsPath, branch));
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
			const pr = await codeHostRuntime.runPromise(
				codeHost.createChangeRequest(repo, branch, baseBranch, title, body),
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
			await trackerRuntime.runPromise(
				tracker.transitionState(
					repo,
					issue.number,
					"running",
					"awaiting_review",
				),
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
		const error = formatExecError(err);
		recordFailure(phase, error);
		return { ok: false, phase, error };
	}

	async function markIssueFailed(repo: RepoSlug, issue: Issue): Promise<void> {
		await trackerRuntime
			.runPromise(tracker.markFailed(repo, issue.number))
			.catch((err) => {
				canonicalLog.append("warnings", {
					kind: "mark_failed_failed",
					issue: `${repo}#${issue.number}`,
					error: formatExecError(err),
				});
			});
	}

	return { dispatch };
}

// Node's child_process errors keep the rich detail (stderr/stdout) on the error
// object rather than in `err.message` — message is just "Command failed: …".
// Surface stderr/stdout so failure diagnostics survive logging.
function formatExecError(err: unknown): string {
	if (!(err instanceof Error)) return String(err);
	const e = err as Error & { stderr?: unknown; stdout?: unknown };
	const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
	const stdout = typeof e.stdout === "string" ? e.stdout.trim() : "";
	const parts = [e.message];
	if (stderr) parts.push(`stderr:\n${stderr}`);
	if (stdout) parts.push(`stdout:\n${stdout}`);
	return parts.join("\n");
}
