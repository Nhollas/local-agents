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
type TickState = {
	runningByIssue: Map<IssueKey, RunId[]>;
	runningCount: number;
	pending: TaggedIssue[];
	stillRunning: Map<RepoSlug, Set<IssueKey>>;
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
		const entries = [...workflows.entries()];

		const dbSnapshot = runRepo.getRunningSnapshot();
		const runningByIssue = new Map<IssueKey, RunId[]>();
		for (const r of dbSnapshot) {
			const ids = runningByIssue.get(r.issueKey) ?? [];
			ids.push(r.id);
			runningByIssue.set(r.issueKey, ids);
		}

		const [pendingResults, runningResults] = await Promise.all([
			Promise.allSettled(
				entries.map(async ([repo, workflow]) => {
					const issues = await tracker.fetchActiveIssues(repo, "pending");
					return issues.map(
						(issue): TaggedIssue => ({ issue, repo, workflow }),
					);
				}),
			),
			Promise.allSettled(
				entries.map(async ([repo]) => {
					const issues = await tracker.fetchActiveIssues(repo, "running");
					return { repo, keys: new Set(issues.map((i) => i.key)) };
				}),
			),
		]);

		const pending: TaggedIssue[] = [];
		for (const result of pendingResults) {
			if (result.status === "fulfilled") {
				pending.push(...result.value);
			} else {
				logger.warn(
					{ err: result.reason },
					"orchestrator.fetch_pending_failed",
				);
			}
		}
		pending.sort((a, b) => a.issue.createdAt.localeCompare(b.issue.createdAt));

		const stillRunning = new Map<RepoSlug, Set<IssueKey>>();
		for (const result of runningResults) {
			if (result.status === "fulfilled") {
				stillRunning.set(result.value.repo, result.value.keys);
			} else {
				logger.warn(
					{ err: result.reason },
					"orchestrator.fetch_running_failed",
				);
			}
		}

		return {
			runningByIssue,
			runningCount: dbSnapshot.length,
			pending,
			stillRunning,
		};
	}

	async function reconcileStaleRuns(state: TickState) {
		for (const [key, runIds] of state.runningByIssue) {
			const { repo } = unwrap(tracker.parseIssueKey(key));
			const repoKeys = state.stillRunning.get(repo);
			if (repoKeys && !repoKeys.has(key)) {
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
		}

		for (const [repo, keys] of state.stillRunning) {
			for (const key of keys) {
				if (state.runningByIssue.has(key)) continue;
				const { number } = unwrap(tracker.parseIssueKey(key));
				logger.info({ key }, "orchestrator.reconcile_orphan");
				await tracker
					.transitionState(repo, number, "running", "pending")
					.catch((err) =>
						logger.warn({ key, err }, "orchestrator.orphan_recovery_failed"),
					);
			}
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
			state.runningByIssue.set(issue.key, []);
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

		const { repo, number: issueNumber } = unwrap(
			tracker.parseIssueKey(failedRun.issueKey),
		);
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
