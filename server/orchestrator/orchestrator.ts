import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileSystem } from "@effect/platform";
import { Cause, Effect, type Fiber, Schedule } from "effect";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { AppConfigShape } from "../config/app-config.ts";
import type { RunRepository } from "../run-repository.ts";
import type { RunHandle, Runner } from "../runner/runner.ts";
import type { AppRuntime } from "../runtime.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { IssueKey, RepoSlug } from "../types/brands.ts";
import type { AgentInvokerService } from "../workflow/agent-invoker.ts";
import {
	type AgentInvokerLiveParams,
	makeClaudeSdkAgentInvoker,
} from "../workflow/agent-invoker-live.ts";
import type { RepoWorkflow } from "../workflow/types.ts";
import { resolveAgentEnvironment } from "./agent-env.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { sweepWorkspaces } from "./workspace.ts";

const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_SWEEP_INTERVAL = "1 hour";

// LA ships its own skills at `<repo-root>/skills/`. Resolve relative to this
// source file so the path is tied to the install, not the launch CWD.
const SKILLS_SOURCE_DIR = fileURLToPath(
	new URL("../../skills/", import.meta.url),
);

type LangfuseConfig = {
	host: string;
	projectId: string;
};

type OrchestratorConfig = {
	runRepo: RunRepository;
	tracker: TrackerAdapter;
	runtime: AppRuntime;
	codeHost: CodeHostAdapter;
	config: AppConfigShape;
	workflow: RepoWorkflow;
	runner: Runner;
	langfuse: LangfuseConfig;
	agentFactory?: AgentFactory;
};

export type AgentFactory = (
	params: Omit<AgentInvokerLiveParams, "env" | "logDir">,
) => Effect.Effect<AgentInvokerService, never, FileSystem.FileSystem>;

export type DispatchRequest = {
	issue: Issue;
	repo: RepoSlug;
	workflow: RepoWorkflow;
};

export type QueuedItem = {
	issueKey: IssueKey;
	issueTitle: string;
	repo: Issue["repo"];
	pendingSince: string;
};

export type Orchestrator = {
	dispatch(req: DispatchRequest): Effect.Effect<RunHandle, unknown>;
	sweepNow: Effect.Effect<void>;
	start: Effect.Effect<Fiber.RuntimeFiber<void, never>>;
	getQueueSnapshot(): QueuedItem[];
};

export function createOrchestrator(
	opts: OrchestratorConfig,
): Effect.Effect<Orchestrator> {
	return Effect.sync(() => buildOrchestrator(opts));
}

type QueueEntry = {
	issue: Issue;
	pendingSince: string;
};

type TickState = {
	runningIssueKeys: Set<IssueKey>;
	pending: Issue[];
};

type DispatchTally = {
	dispatched: number;
	skippedAtCapacity: number;
};

function buildOrchestrator(opts: OrchestratorConfig): Orchestrator {
	const holdingQueue = new Map<IssueKey, QueueEntry>();

	const {
		runRepo,
		tracker,
		runtime,
		codeHost,
		config,
		workflow,
		runner,
		langfuse,
	} = opts;
	const { defaults } = config;
	const agentEnv = resolveAgentEnvironment(config.agent.env);
	const logDir = resolvePath(process.cwd(), defaults.log_dir);
	const agentFactory: AgentFactory =
		opts.agentFactory ??
		((params) =>
			makeClaudeSdkAgentInvoker({ env: agentEnv, logDir, ...params }));

	const lifecycle = createRunLifecycle({
		runner,
		repo: runRepo,
		tracker,
		runtime,
		codeHost,
		agentFactory,
		workspaceRoot: defaults.workspace_root,
		skillsSourceDir: SKILLS_SOURCE_DIR,
		agentEnv,
		langfuseHost: langfuse.host,
		langfuseProjectId: langfuse.projectId,
	});

	const dispatch = (req: DispatchRequest): Effect.Effect<RunHandle, unknown> =>
		Effect.tryPromise({ try: () => lifecycle.dispatch(req), catch: (e) => e });

	const fetchTickState: Effect.Effect<TickState> = Effect.gen(function* () {
		const runningIssueKeys = new Set(
			runRepo.getRunningSnapshot().map((r) => r.issueKey),
		);
		const pending = yield* Effect.tryPromise({
			try: () => runtime.runPromise(tracker.fetchActiveIssues("pending")),
			catch: (err) => err,
		}).pipe(
			Effect.map((page) =>
				[...page.issues].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
			),
			Effect.catchAll((err) =>
				Effect.logWarning("orchestrator.fetch_active_issues_failed").pipe(
					Effect.annotateLogs({
						state: "pending",
						error: errMessage(err),
					}),
					Effect.as<Issue[]>([]),
				),
			),
		);
		return { runningIssueKeys, pending };
	});

	function reconcileQueue(state: TickState): void {
		const pendingByKey = new Map(state.pending.map((i) => [i.key, i]));

		for (const key of holdingQueue.keys()) {
			if (!pendingByKey.has(key) || state.runningIssueKeys.has(key)) {
				holdingQueue.delete(key);
			}
		}

		const nowIso = new Date().toISOString();
		for (const issue of state.pending) {
			if (state.runningIssueKeys.has(issue.key)) continue;
			const existing = holdingQueue.get(issue.key);
			if (existing) {
				existing.issue = issue;
			} else {
				holdingQueue.set(issue.key, { issue, pendingSince: nowIso });
			}
		}
	}

	const dispatchFromQueue = (state: TickState): Effect.Effect<DispatchTally> =>
		Effect.gen(function* () {
			const tally: DispatchTally = { dispatched: 0, skippedAtCapacity: 0 };
			for (const entry of [...holdingQueue.values()]) {
				const { issue } = entry;
				if (state.runningIssueKeys.has(issue.key)) continue;
				if (state.runningIssueKeys.size >= defaults.max_concurrent) {
					tally.skippedAtCapacity += 1;
					continue;
				}

				const transitioned = yield* runTrackerTransition(
					issue,
					"pending",
					"running",
				);
				if (!transitioned) continue;

				const dispatched = yield* dispatch({
					issue,
					repo: issue.repo,
					workflow,
				}).pipe(
					Effect.map(() => true),
					Effect.catchAll((err) =>
						Effect.logWarning("orchestrator.dispatch_failed")
							.pipe(
								Effect.annotateLogs({
									issue_key: issue.key,
									error: errMessage(err),
								}),
							)
							.pipe(
								Effect.zipRight(
									runTrackerTransition(issue, "running", "pending").pipe(
										Effect.as(false),
									),
								),
							),
					),
				);
				if (!dispatched) continue;

				holdingQueue.delete(issue.key);
				state.runningIssueKeys.add(issue.key);
				tally.dispatched += 1;
			}
			return tally;
		});

	const runTrackerTransition = (
		issue: Issue,
		from: "pending" | "running",
		to: "pending" | "running",
	): Effect.Effect<boolean> =>
		Effect.tryPromise({
			try: () =>
				runtime.runPromise(
					tracker.transitionState(issue.repo, issue.number, from, to),
				),
			catch: (err) => err,
		}).pipe(
			Effect.as(true),
			Effect.catchAll((err) =>
				Effect.logWarning("orchestrator.state_transition_failed").pipe(
					Effect.annotateLogs({
						issue: `${issue.repo}#${issue.number}`,
						from,
						to,
						error: errMessage(err),
					}),
					Effect.as(false),
				),
			),
		);

	const tick: Effect.Effect<void> = Effect.gen(function* () {
		const state = yield* fetchTickState;
		yield* Effect.annotateCurrentSpan({
			pending_count: state.pending.length,
			running_count: state.runningIssueKeys.size,
		});
		reconcileQueue(state);
		yield* Effect.annotateCurrentSpan({ queued_count: holdingQueue.size });
		const tally = yield* dispatchFromQueue(state);
		yield* Effect.annotateCurrentSpan({
			dispatched_count: tally.dispatched,
			skipped_at_capacity: tally.skippedAtCapacity,
		});
	}).pipe(Effect.withSpan("orchestrator.tick"));

	const recover: Effect.Effect<void> = Effect.gen(function* () {
		const completedAt = new Date().toISOString();
		let staleRunsFailed = 0;
		for (const run of runRepo.getRunningSnapshot()) {
			runRepo.failRun(run.id, {
				error: "Stale run from previous session",
				completedAt,
			});
			staleRunsFailed += 1;
		}
		yield* Effect.annotateCurrentSpan({
			stale_runs_failed: staleRunsFailed,
			tracker_orphans_recovered: 0,
		});

		// Tracker issues stuck "running" mean the previous process died mid-flight;
		// push them back to "pending" so the next tick re-dispatches.
		const fetched = yield* Effect.tryPromise({
			try: () => runtime.runPromise(tracker.fetchActiveIssues("running")),
			catch: (err) => err,
		}).pipe(
			Effect.map((page) => page.issues),
			Effect.catchAll((err) =>
				Effect.logWarning("orchestrator.fetch_active_issues_failed").pipe(
					Effect.annotateLogs({
						state: "running",
						error: errMessage(err),
					}),
					Effect.as<readonly Issue[] | null>(null),
				),
			),
		);
		if (fetched === null) return;

		const recovered = yield* Effect.all(
			fetched.map((issue) => runTrackerTransition(issue, "running", "pending")),
			{ concurrency: "unbounded" },
		);
		yield* Effect.annotateCurrentSpan({
			tracker_orphans_recovered: recovered.filter((ok) => ok).length,
		});
	}).pipe(Effect.withSpan("orchestrator.recover"));

	const sweepNow: Effect.Effect<void> = Effect.tryPromise({
		try: () =>
			runtime.runPromise(
				sweepWorkspaces(defaults.workspace_root, WORKSPACE_TTL_MS),
			),
		catch: (err) => err,
	}).pipe(
		Effect.tap((swept) =>
			swept.removed.length > 0
				? Effect.logInfo("orchestrator.workspaces_swept").pipe(
						Effect.annotateLogs({ count: swept.removed.length }),
					)
				: Effect.void,
		),
		Effect.catchAll((err) =>
			Effect.logWarning("orchestrator.workspace_sweep_failed").pipe(
				Effect.annotateLogs({ error: errMessage(err) }),
			),
		),
		Effect.asVoid,
	);

	const safeTick = tick.pipe(
		Effect.catchAllCause((cause) =>
			Effect.logError("orchestrator.tick_failed").pipe(
				Effect.annotateLogs({ err: Cause.pretty(cause) }),
			),
		),
	);

	const mainLoop = Effect.gen(function* () {
		yield* recover.pipe(
			Effect.catchAllCause((cause) =>
				Effect.logError("orchestrator.recover_failed").pipe(
					Effect.annotateLogs({ err: Cause.pretty(cause) }),
				),
			),
		);
		yield* safeTick.pipe(
			Effect.repeat(Schedule.spaced(`${defaults.polling_interval_ms} millis`)),
		);
	});

	const sweepLoop = sweepNow.pipe(
		Effect.repeat(Schedule.spaced(WORKSPACE_SWEEP_INTERVAL)),
	);

	const start: Effect.Effect<Fiber.RuntimeFiber<void, never>> = Effect.gen(
		function* () {
			yield* Effect.logInfo("orchestrator.starting").pipe(
				Effect.annotateLogs({ interval: defaults.polling_interval_ms }),
			);
			yield* Effect.forkDaemon(sweepLoop);
			return yield* Effect.forkDaemon(mainLoop);
		},
	);

	return {
		dispatch,
		sweepNow,
		start,
		getQueueSnapshot() {
			return [...holdingQueue.values()].map((entry) => ({
				issueKey: entry.issue.key,
				issueTitle: entry.issue.title,
				repo: entry.issue.repo,
				pendingSince: entry.pendingSince,
			}));
		},
	};
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
