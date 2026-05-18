import { join } from "node:path";
import { trace } from "@opentelemetry/api";
import { Effect, Fiber, Layer, Queue } from "effect";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { RunRepository } from "../run-repository.ts";
import type {
	RunContext,
	RunHandle,
	Runner,
	RunResult as RunnerRunResult,
} from "../runner/runner.ts";
import type { AppRuntime } from "../runtime.ts";
import { runRunSpan } from "../telemetry/spans.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { RepoSlug } from "../types/brands.ts";
import { AgentInvoker } from "../workflow/agent-invoker.ts";
import {
	type WorkflowEvent,
	WorkflowEventEmitterLive,
} from "../workflow/event-emitter-live.ts";
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
							return await runOnce(ctx, issue, repo, workflow, {
								cloneUrl,
								baseBranch,
							});
						} finally {
							console.log(`langfuse trace: ${langfuseTraceUrl}`);
						}
					},
				),
		});
	}

	async function runOnce(
		ctx: RunContext,
		issue: Issue,
		repo: RepoSlug,
		workflow: RepoWorkflow,
		urls: { cloneUrl: string; baseBranch: string },
	): Promise<RunnerRunResult> {
		const startMs = Date.now();
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
			const agent = agentFactory({
				cwd: wsPath,
				runId: ctx.runId,
				signal: ctx.signal,
			});
			const perRunLayers = Layer.mergeAll(
				Layer.succeed(AgentInvoker, agent),
				WorkflowEventEmitterLive(eventQueue),
				Layer.succeed(PhaseInputs, {
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

		const phaseResult = await runtime.runPromise(program);
		const runnerResult = phaseResultToRunnerResult(
			phaseResult,
			Date.now() - startMs,
		);
		trace.getActiveSpan()?.setAttribute("run.status", runnerResult.status);

		if (
			phaseResult.status === "completed" &&
			phaseResult.state.wsPath !== undefined
		) {
			await runtime.runPromise(removeWorkspace(phaseResult.state.wsPath));
		} else {
			await markIssueFailedSafe(repo, issue);
		}

		return runnerResult;
	}

	async function markIssueFailedSafe(
		repo: RepoSlug,
		issue: Issue,
	): Promise<void> {
		await runtime
			.runPromise(tracker.markFailed(repo, issue.number))
			.catch((err) => {
				console.warn(
					`mark_failed_failed ${repo}#${issue.number}: ${err instanceof Error ? err.message : String(err)}`,
				);
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
