import { join } from "node:path";
import * as Tracer from "@effect/opentelemetry/Tracer";
import type {
	CommandExecutor as CommandExecutorModule,
	FileSystem as FileSystemModule,
} from "@effect/platform";
import { Cause, Effect, Fiber, Layer, Queue } from "effect";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { RunRepository } from "../run-repository.ts";
import type {
	RunContext,
	RunHandle,
	Runner,
	RunResult as RunnerRunResult,
} from "../runner/runner.ts";
import type { AppRuntime } from "../runtime.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { RepoSlug } from "../types/brands.ts";
import {
	type WorkflowEvent,
	WorkflowEventEmitter,
} from "../workflow/event-emitter.ts";
import type { PromptScope, RepoWorkflow } from "../workflow/types.ts";
import { consumeWorkflowEvents } from "./event-consumer.ts";
import type { AgentFactory } from "./orchestrator.ts";
import { PhaseInputs } from "./phases/inputs.ts";
import type { RunResult as WalkerResult } from "./phases/types.ts";
import {
	formatPhaseCause,
	toFinalizeFailurePhase,
} from "./phases/with-observability.ts";
import { runLifecycleWalker } from "./walker.ts";
import { removeWorkspace, sanitizeKey } from "./workspace.ts";

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
	runtime: AppRuntime;
	codeHost: CodeHostAdapter;
	agentFactory: AgentFactory;
	workspaceRoot: string;
	skillsSourceDir: string;
	agentEnv: Record<string, string>;
	langfuseHost: string;
	langfuseProjectId: string;
};

export function createRunLifecycle(deps: RunLifecycleDeps): RunLifecycle {
	const {
		runner,
		repo: runRepo,
		tracker,
		runtime,
		codeHost,
		agentFactory,
		workspaceRoot,
		skillsSourceDir,
		agentEnv,
		langfuseHost,
		langfuseProjectId,
	} = deps;

	async function dispatch(req: RunRequest): Promise<RunHandle> {
		const { issue, repo, workflow } = req;
		const cloneUrl = codeHost.cloneUrl(repo);
		const baseBranch = await runtime.runPromise(codeHost.defaultBranch(repo));

		return runner.enqueue({
			repo,
			repoUrl: codeHost.repoUrl(repo),
			issueKey: issue.key,
			issueTitle: issue.title,
			issueUrl: issue.url,
			handler: (ctx) =>
				runtime.runPromise(
					runOne(ctx, issue, repo, workflow, { cloneUrl, baseBranch }).pipe(
						Effect.withSpan("run", {
							attributes: {
								"run.id": ctx.runId,
								"issue.key": issue.key,
								"langfuse.trace.name": `${issue.key}: ${issue.title}`,
								"langfuse.session.id": ctx.runId,
								"langfuse.trace.input": JSON.stringify({
									issueKey: issue.key,
									issueTitle: issue.title,
									issueUrl: issue.url,
									repo,
								}),
								"langfuse.trace.tags": [repo, issue.key],
								"langfuse.trace.metadata.run_id": ctx.runId,
								"langfuse.trace.metadata.issue_key": issue.key,
								"langfuse.trace.metadata.repo": repo,
								"langfuse.trace.metadata.issue_url": issue.url,
							},
						}),
					),
				),
		});
	}

	function runOne(
		ctx: RunContext,
		issue: Issue,
		repo: RepoSlug,
		workflow: RepoWorkflow,
		urls: { cloneUrl: string; baseBranch: string },
	): Effect.Effect<
		RunnerRunResult,
		never,
		FileSystemModule.FileSystem | CommandExecutorModule.CommandExecutor
	> {
		const wsPath = join(
			workspaceRoot,
			`${sanitizeKey(issue.key)}-${ctx.runId}`,
		);
		const scope: PromptScope = {
			issue: {
				key: issue.key,
				number: issue.number,
				title: issue.title,
				description: issue.description,
				labels: issue.labels,
				url: issue.url,
				createdAt: issue.createdAt,
			},
			baseBranch: urls.baseBranch,
		};

		return Effect.gen(function* () {
			const startMs = Date.now();

			const traceUrl = yield* Tracer.currentOtelSpan.pipe(
				Effect.map(
					(span) =>
						`${langfuseHost}/project/${langfuseProjectId}/traces/${span.spanContext().traceId}`,
				),
				Effect.orElseSucceed(() => undefined),
			);
			if (traceUrl) runRepo.setRunLangfuseTraceUrl(ctx.runId, traceUrl);

			const program = Effect.gen(function* () {
				const eventQueue = yield* Queue.unbounded<WorkflowEvent>();
				const consumer = yield* Effect.fork(
					consumeWorkflowEvents(eventQueue, {
						runRepo,
						ctx,
						runId: ctx.runId,
						cwd: wsPath,
						steps: workflow.steps,
					}),
				);
				const perRunLayers = Layer.mergeAll(
					agentFactory({
						cwd: wsPath,
						runId: ctx.runId,
						signal: ctx.signal,
					}),
					WorkflowEventEmitter.Default(eventQueue),
					PhaseInputs.Default({
						issue,
						repo,
						cloneUrl: urls.cloneUrl,
						baseBranch: urls.baseBranch,
						runId: ctx.runId,
						workspaceRoot,
						skillsSourceDir,
						agentEnv,
						scope,
						workflow,
						runRepo,
						emit: ctx.emit,
						codeHost,
						tracker,
					}),
				);

				const result = yield* runLifecycleWalker.pipe(
					Effect.provide(perRunLayers),
				);
				yield* Queue.shutdown(eventQueue);
				yield* Fiber.join(consumer);
				return result;
			});

			const phaseResult = yield* program;
			const runnerResult = phaseResultToRunnerResult(
				phaseResult,
				Date.now() - startMs,
			);
			yield* Effect.annotateCurrentSpan("run.status", runnerResult.status);

			if (
				phaseResult.status === "completed" &&
				phaseResult.state.wsPath !== undefined
			) {
				yield* removeWorkspace(phaseResult.state.wsPath).pipe(
					Effect.catchAllCause((cause) =>
						Effect.logWarning("run_lifecycle.workspace_cleanup_failed").pipe(
							Effect.annotateLogs({ err: Cause.pretty(cause) }),
						),
					),
				);
			} else {
				yield* tracker.markFailed(repo, issue.number).pipe(
					Effect.catchAllCause((cause) =>
						Effect.logWarning("run_lifecycle.mark_failed_failed").pipe(
							Effect.annotateLogs({
								repo,
								issue: issue.number,
								err: Cause.pretty(cause),
							}),
						),
					),
				);
			}

			if (traceUrl) console.log(`langfuse trace: ${traceUrl}`);
			return runnerResult;
		});
	}

	return { dispatch };
}

function phaseResultToRunnerResult(
	result: WalkerResult,
	durationMs: number,
): RunnerRunResult {
	if (result.status === "completed") {
		return { status: "completed", durationMs };
	}
	const error = formatPhaseCause(result.cause);
	const finalize = toFinalizeFailurePhase(result.phase);
	if (finalize) {
		return {
			status: "failed",
			error: `${finalize}: ${error}`,
			durationMs,
			finalizeFailure: { phase: finalize, error },
		};
	}
	return { status: "failed", error, durationMs };
}
