import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { IssueKey } from "../types/brands.ts";
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
	/** Reconcile DB and tracker state left over from a previous process. */
	recover(): Promise<void>;
	/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
	settled(): Promise<void>;
	start(): void;
	stop(): void;
};

type TickState = {
	runningIssueKeys: Set<IssueKey>;
	pending: Issue[];
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
		const runningIssueKeys = new Set(
			runRepo.getRunningSnapshot().map((r) => r.issueKey),
		);

		let pending: Issue[];
		try {
			const result = await tracker.fetchActiveIssues("pending");
			pending = [...result.issues];
		} catch (err) {
			logger.warn({ err }, "orchestrator.fetch_pending_failed");
			pending = [];
		}
		pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		return { runningIssueKeys, pending };
	}

	async function recover() {
		const completedAt = new Date(clock.now()).toISOString();
		for (const run of runRepo.getRunningSnapshot()) {
			runRepo.failRun(run.id, {
				error: "Stale run from previous session",
				completedAt,
			});
		}

		// Tracker issues stuck "running" mean the previous process died mid-flight;
		// push them back to "pending" so the next tick re-dispatches.
		let runningIssues: readonly Issue[];
		try {
			const result = await tracker.fetchActiveIssues("running");
			runningIssues = result.issues;
		} catch (err) {
			logger.warn({ err }, "orchestrator.recovery_fetch_failed");
			return;
		}

		for (const issue of runningIssues) {
			logger.info({ key: issue.key }, "orchestrator.recovery_orphan");
			await tracker
				.transitionState(issue.repo, issue.number, "running", "pending")
				.catch((err) =>
					logger.warn(
						{ key: issue.key, err },
						"orchestrator.recovery_transition_failed",
					),
				);
		}
	}

	async function dispatchPendingIssues(state: TickState) {
		for (const issue of state.pending) {
			if (state.runningIssueKeys.has(issue.key)) continue;
			if (state.runningIssueKeys.size >= defaults.max_concurrent) break;

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

			state.runningIssueKeys.add(issue.key);
			logger.info({ issue: issue.key }, "orchestrator.dispatched");
		}
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			const state = await fetchTickState();
			await dispatchPendingIssues(state);
		} finally {
			ticking = false;
		}
	}

	return {
		tick,
		recover,
		async settled() {
			await Promise.all(pendingPostRuns);
		},
		start() {
			logger.info(
				{ interval: opts.config.defaults.polling_interval_ms },
				"orchestrator.starting",
			);
			void (async () => {
				try {
					await recover();
					await tick();
				} catch (err) {
					logger.error({ err }, "orchestrator.tick_failed");
				}
				timer = setInterval(
					() =>
						tick().catch((err) =>
							logger.error({ err }, "orchestrator.tick_failed"),
						),
					opts.config.defaults.polling_interval_ms,
				);
			})();
		},
		stop() {
			clearInterval(timer);
		},
	};
}
