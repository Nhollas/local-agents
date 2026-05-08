import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
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
	logger: Logger;
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

type DispatchTally = {
	dispatched: number;
	skippedAtCapacity: number;
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
		logger,
		agent = claudeSdkAgentInvoker(),
		clock = systemClock(),
		runShell = realRunShell,
	} = opts;
	const { defaults } = config;

	function logTransitionFailed(
		repo: Issue["repo"],
		number: Issue["number"],
		from: "pending" | "running",
		to: "pending" | "running",
		err: unknown,
	): void {
		canonicalLog.append("warnings", {
			kind: "state_transition_failed",
			issue: `${repo}#${number}`,
			from,
			to,
			error: err instanceof Error ? err.message : String(err),
		});
	}

	const lifecycle = createRunLifecycle({
		runner,
		repo: runRepo,
		tracker,
		codeHost,
		agent,
		clock,
		runShell,
		logger,
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
			canonicalLog.append("warnings", {
				kind: "fetch_active_issues_failed",
				state: "pending",
				error: err instanceof Error ? err.message : String(err),
			});
			pending = [];
		}
		pending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

		return { runningIssueKeys, pending };
	}

	async function recover() {
		await canonicalLog.run(
			{ scope: "recovery" },
			async () => {
				const completedAt = new Date(clock.now()).toISOString();
				let staleRunsFailed = 0;
				for (const run of runRepo.getRunningSnapshot()) {
					runRepo.failRun(run.id, {
						error: "Stale run from previous session",
						completedAt,
					});
					staleRunsFailed += 1;
				}
				canonicalLog.set({
					stale_runs_failed: staleRunsFailed,
					tracker_orphans_recovered: 0,
				});

				// Tracker issues stuck "running" mean the previous process died mid-flight;
				// push them back to "pending" so the next tick re-dispatches.
				let runningIssues: readonly Issue[];
				try {
					const result = await tracker.fetchActiveIssues("running");
					runningIssues = result.issues;
				} catch (err) {
					canonicalLog.append("warnings", {
						kind: "fetch_active_issues_failed",
						state: "running",
						error: err instanceof Error ? err.message : String(err),
					});
					return;
				}

				const results = await Promise.allSettled(
					runningIssues.map((issue) =>
						tracker.transitionState(
							issue.repo,
							issue.number,
							"running",
							"pending",
						),
					),
				);
				for (const [index, r] of results.entries()) {
					if (r.status === "rejected") {
						const issue = runningIssues[index]!;
						logTransitionFailed(
							issue.repo,
							issue.number,
							"running",
							"pending",
							r.reason,
						);
					}
				}
				canonicalLog.set({
					tracker_orphans_recovered: results.filter(
						(r) => r.status === "fulfilled",
					).length,
				});
			},
			logger,
		);
	}

	async function dispatchPendingIssues(
		state: TickState,
	): Promise<DispatchTally> {
		const tally: DispatchTally = {
			dispatched: 0,
			skippedAtCapacity: 0,
		};
		for (const issue of state.pending) {
			if (state.runningIssueKeys.has(issue.key)) continue;
			if (state.runningIssueKeys.size >= defaults.max_concurrent) {
				tally.skippedAtCapacity += 1;
				continue;
			}

			const { repo } = issue;
			try {
				await tracker.transitionState(repo, issue.number, "pending", "running");
			} catch (err) {
				logTransitionFailed(repo, issue.number, "pending", "running", err);
				continue;
			}

			try {
				const handle = await lifecycle.dispatch({ issue, repo, workflow });
				trackPostRun(handle.done);
			} catch (err) {
				canonicalLog.append("warnings", {
					kind: "dispatch_failed",
					issue_key: issue.key,
					error: err instanceof Error ? err.message : String(err),
				});
				await tracker
					.transitionState(repo, issue.number, "running", "pending")
					.catch((rollbackErr) => {
						logTransitionFailed(
							repo,
							issue.number,
							"running",
							"pending",
							rollbackErr,
						);
					});
				continue;
			}

			state.runningIssueKeys.add(issue.key);
			tally.dispatched += 1;
		}
		return tally;
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			await canonicalLog.run(
				{ scope: "tick" },
				async () => {
					const state = await fetchTickState();
					canonicalLog.set({
						pending_count: state.pending.length,
						running_count: state.runningIssueKeys.size,
					});
					const tally = await dispatchPendingIssues(state);
					canonicalLog.set({
						dispatched_count: tally.dispatched,
						skipped_at_capacity: tally.skippedAtCapacity,
					});
				},
				logger,
			);
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
				{ interval: defaults.polling_interval_ms },
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
					defaults.polling_interval_ms,
				);
			})();
		},
		stop() {
			clearInterval(timer);
		},
	};
}
