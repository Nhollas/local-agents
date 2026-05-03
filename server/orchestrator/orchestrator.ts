import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { IssueKey, RepoSlug, RunId } from "../types/brands.ts";
import { unwrap } from "../types/result.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { type AgentInvoker, claudeSdkAgentInvoker } from "./agent-invoker.ts";
import { type Clock, systemClock } from "./clock.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { type RunShell, realRunShell } from "./workspace.ts";

type OrchestratorConfig = {
	runRepo: RunRepository;
	tracker: TrackerAdapter;
	codeHost: CodeHostAdapter;
	config: Config;
	workflows: Map<RepoSlug, RepoWorkflow>;
	runner: Runner;
	agent?: AgentInvoker;
	clock?: Clock;
	runShell?: RunShell;
};

type Orchestrator = {
	tick(): Promise<void>;
	retryRun(failedRunId: RunId): Promise<{ runId: RunId } | { error: string }>;
	/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
	settled(): Promise<void>;
	start(): void;
	stop(): void;
};

type TaggedIssue = { issue: Issue; repo: RepoSlug; workflow: RepoWorkflow };
type RunningEntry = { runIds: RunId[]; repo: RepoSlug };
type StillRunning = {
	issues: readonly Issue[];
	keys: ReadonlySet<IssueKey>;
	reposReached: ReadonlySet<RepoSlug>;
};
type TickState = {
	runningByIssue: Map<IssueKey, RunningEntry>;
	runningCount: number;
	pending: TaggedIssue[];
	stillRunning: StillRunning;
};

export function createOrchestrator(opts: OrchestratorConfig): Orchestrator {
	let timer: ReturnType<typeof setInterval>;
	let ticking = false;
	const pendingPostRuns = new Set<Promise<unknown>>();

	const {
		runRepo,
		tracker,
		codeHost,
		config,
		workflows,
		runner,
		agent = claudeSdkAgentInvoker(),
		clock = systemClock(),
		runShell = realRunShell,
	} = opts;
	const { defaults } = config;

	const lifecycle = createRunLifecycle({
		runner,
		repo: runRepo,
		tracker,
		codeHost,
		agent,
		clock,
		runShell,
		workspaceRoot: defaults.workspace_root,
		model: defaults.model,
		maxRetries: defaults.max_retries,
	});

	function trackPostRun(done: Promise<unknown>): void {
		pendingPostRuns.add(done);
		done.finally(() => pendingPostRuns.delete(done));
	}

	async function fetchTickState(): Promise<TickState> {
		const dbSnapshot = runRepo.getRunningSnapshot();
		const runningByIssue = new Map<IssueKey, RunningEntry>();
		for (const r of dbSnapshot) {
			const entry = runningByIssue.get(r.issueKey) ?? {
				runIds: [],
				repo: r.repo,
			};
			entry.runIds.push(r.id);
			runningByIssue.set(r.issueKey, entry);
		}

		const [pendingResult, runningResult] = await Promise.allSettled([
			tracker.fetchActiveIssues("pending"),
			tracker.fetchActiveIssues("running"),
		]);

		const pending: TaggedIssue[] = [];
		if (pendingResult.status === "fulfilled") {
			for (const issue of pendingResult.value.issues) {
				const workflow = workflows.get(issue.repo);
				if (!workflow) continue;
				pending.push({ issue, repo: issue.repo, workflow });
			}
		} else {
			logger.warn(
				{ err: pendingResult.reason },
				"orchestrator.fetch_pending_failed",
			);
		}
		pending.sort((a, b) => a.issue.createdAt.localeCompare(b.issue.createdAt));

		let stillRunning: StillRunning;
		if (runningResult.status === "fulfilled") {
			const issues = runningResult.value.issues;
			stillRunning = {
				issues,
				keys: new Set(issues.map((i) => i.key)),
				reposReached: runningResult.value.reposReached,
			};
		} else {
			logger.warn(
				{ err: runningResult.reason },
				"orchestrator.fetch_running_failed",
			);
			stillRunning = {
				issues: [],
				keys: new Set(),
				reposReached: new Set(),
			};
		}

		return {
			runningByIssue,
			runningCount: dbSnapshot.length,
			pending,
			stillRunning,
		};
	}

	async function reconcileStaleRuns(state: TickState) {
		const { issues, keys, reposReached } = state.stillRunning;

		for (const [key, { runIds, repo }] of state.runningByIssue) {
			if (!reposReached.has(repo)) continue;
			if (keys.has(key)) continue;
			logger.info({ key }, "orchestrator.reconcile_terminal");
			for (const id of runIds) {
				const killed = runner.kill(id);
				if (!killed) {
					runRepo.failRun(id, {
						error: "Stale run from previous session",
						completedAt: new Date().toISOString(),
					});
				}
			}
		}

		for (const issue of issues) {
			if (state.runningByIssue.has(issue.key)) continue;
			logger.info({ key: issue.key }, "orchestrator.reconcile_orphan");
			await tracker
				.transitionState(issue.repo, issue.number, "running", "pending")
				.catch((err) =>
					logger.warn(
						{ key: issue.key, err },
						"orchestrator.orphan_recovery_failed",
					),
				);
		}
	}

	async function dispatchPendingIssues(state: TickState) {
		let { runningCount } = state;

		for (const { issue, repo, workflow } of state.pending) {
			if (state.runningByIssue.has(issue.key)) continue;
			if (runningCount >= defaults.max_concurrent) break;

			await tracker.transitionState(repo, issue.number, "pending", "running");

			try {
				const handle = await lifecycle.dispatch({
					issue,
					repo,
					workflow,
					attempt: 1,
				});
				trackPostRun(handle.done);
			} catch (err) {
				logger.warn({ issue: issue.key, err }, "orchestrator.dispatch_failed");
				await tracker
					.transitionState(repo, issue.number, "running", "pending")
					.catch((rollbackErr) =>
						logger.warn(
							{ issue: issue.key, err: rollbackErr },
							"orchestrator.rollback_failed",
						),
					);
				continue;
			}

			runningCount++;
			state.runningByIssue.set(issue.key, { runIds: [], repo });
			logger.info({ issue: issue.key }, "orchestrator.dispatched");
		}
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			const state = await fetchTickState();
			await reconcileStaleRuns(state);
			await dispatchPendingIssues(state);
		} finally {
			ticking = false;
		}
	}

	async function retryRun(
		failedRunId: RunId,
	): Promise<{ runId: RunId } | { error: string }> {
		const failedRun = runRepo.getRunById(failedRunId);
		if (!failedRun) return { error: "Run not found" };
		if (failedRun.status !== "failed") return { error: "Run is not failed" };
		if (!failedRun.issueKey) return { error: "No issue key" };

		const attempt = failedRun.attempt + 1;
		if (attempt > defaults.max_retries + 1)
			return { error: "Max retries exceeded" };

		const snapshot = runRepo.getRunningSnapshot();
		if (snapshot.some((r) => r.issueKey === failedRun.issueKey)) {
			return { error: "Issue already has a running agent" };
		}

		const { number: issueNumber } = unwrap(
			tracker.parseIssueKey(failedRun.issueKey),
		);
		const repo = failedRun.repo;
		const workflow = workflows.get(repo);
		if (!workflow) return { error: "No workflow for repo" };

		const issue = await tracker.fetchIssue(repo, issueNumber);

		const handle = await lifecycle.dispatch({
			issue,
			repo,
			workflow,
			attempt,
			resume: {
				parentRunId: failedRunId,
				startStepIndex: failedRun.stepIndex,
				...(failedRun.sessionId && { sessionId: failedRun.sessionId }),
			},
		});
		trackPostRun(handle.done);

		logger.info(
			{ issue: issue.key, attempt, parentRunId: failedRunId },
			"orchestrator.retry_dispatched",
		);

		return { runId: handle.runId };
	}

	return {
		tick,
		retryRun,
		async settled() {
			await Promise.all(pendingPostRuns);
		},
		start() {
			logger.info(
				{ interval: opts.config.defaults.polling_interval_ms },
				"orchestrator.starting",
			);
			tick().catch((err) => logger.error({ err }, "orchestrator.tick_failed"));
			timer = setInterval(
				() =>
					tick().catch((err) =>
						logger.error({ err }, "orchestrator.tick_failed"),
					),
				opts.config.defaults.polling_interval_ms,
			);
		},
		stop() {
			clearInterval(timer);
		},
	};
}
