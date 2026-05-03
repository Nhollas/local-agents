import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import { resolveRepo } from "../scope-resolver.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { IssueKey, RepoSlug, RunId } from "../types/brands.ts";
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
	workflow: RepoWorkflow;
	runner: Runner;
	agent?: AgentInvoker;
	clock?: Clock;
	runShell?: RunShell;
};

type Orchestrator = {
	tick(): Promise<void>;
	/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
	settled(): Promise<void>;
	start(): void;
	stop(): void;
};

type RunningEntry = { runIds: RunId[]; repo: RepoSlug };
type StillRunning = {
	issues: readonly Issue[];
	keys: ReadonlySet<IssueKey>;
	scopesReached: ReadonlySet<RepoSlug>;
};
type TickState = {
	runningByIssue: Map<IssueKey, RunningEntry>;
	runningCount: number;
	pending: Issue[];
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
		workflow,
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

		const pending: Issue[] =
			pendingResult.status === "fulfilled"
				? [...pendingResult.value.issues]
				: [];
		if (pendingResult.status === "rejected") {
			logger.warn(
				{ err: pendingResult.reason },
				"orchestrator.fetch_pending_failed",
			);
		}
		pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		let stillRunning: StillRunning;
		if (runningResult.status === "fulfilled") {
			const issues = runningResult.value.issues;
			stillRunning = {
				issues,
				keys: new Set(issues.map((i) => i.key)),
				scopesReached: runningResult.value.scopesReached,
			};
		} else {
			logger.warn(
				{ err: runningResult.reason },
				"orchestrator.fetch_running_failed",
			);
			stillRunning = {
				issues: [],
				keys: new Set(),
				scopesReached: new Set(),
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
		const { issues, keys, scopesReached } = state.stillRunning;
		const reachableScopes = [...scopesReached];

		for (const [key, { runIds, repo }] of state.runningByIssue) {
			if (!resolveRepo(repo, reachableScopes)) continue;
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

		for (const issue of state.pending) {
			if (state.runningByIssue.has(issue.key)) continue;
			if (runningCount >= defaults.max_concurrent) break;

			const { repo } = issue;
			await tracker.transitionState(repo, issue.number, "pending", "running");

			try {
				const handle = await lifecycle.dispatch({ issue, repo, workflow });
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

	return {
		tick,
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
