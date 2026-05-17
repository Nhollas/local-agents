import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostRuntime } from "../code-hosts/runtime.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import type { TrackerRuntime } from "../trackers/runtime.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { IssueKey } from "../types/brands.ts";
import type { WorkflowRuntime } from "../workflow/runtime.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { resolveAgentEnvironment } from "./agent-env.ts";
import {
	type AgentInvoker,
	claudeSdkAgentInvoker,
	type LangfuseConfig,
} from "./agent-invoker.ts";
import { type Clock, systemClock } from "./clock.ts";
import { createRunLifecycle } from "./run-lifecycle.ts";
import { type RunShell, realRunShell, sweepWorkspaces } from "./workspace.ts";

const WORKSPACE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// LA ships its own skills at `<repo-root>/skills/`. Resolve relative to this
// source file so the path is tied to the install, not the launch CWD.
const SKILLS_SOURCE_DIR = fileURLToPath(
	new URL("../../skills/", import.meta.url),
);

type OrchestratorConfig = {
	runRepo: RunRepository;
	tracker: TrackerAdapter;
	trackerRuntime: TrackerRuntime;
	codeHost: CodeHostAdapter;
	codeHostRuntime: CodeHostRuntime;
	workflowRuntime: WorkflowRuntime;
	config: Config;
	workflow: RepoWorkflow;
	runner: Runner;
	logger: Logger;
	langfuse: LangfuseConfig;
	agent?: AgentInvoker;
	clock?: Clock;
	runShell?: RunShell;
};

export type QueuedItem = {
	issueKey: IssueKey;
	issueTitle: string;
	repo: Issue["repo"];
	pendingSince: string;
};

export type Orchestrator = {
	tick(): Promise<void>;
	/** Reconcile DB and tracker state left over from a previous process. */
	recover(): Promise<void>;
	/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
	settled(): Promise<void>;
	start(): void;
	stop(): void;
	/** Snapshot of the in-memory holding queue, ordered by `pendingSince` ascending. */
	getQueueSnapshot(): QueuedItem[];
};

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

export function createOrchestrator(opts: OrchestratorConfig): Orchestrator {
	let timer: ReturnType<typeof setInterval>;
	let ticking = false;
	const pendingPostRuns = new Set<Promise<unknown>>();
	const holdingQueue = new Map<IssueKey, QueueEntry>();

	const {
		runRepo,
		tracker,
		trackerRuntime,
		codeHost,
		codeHostRuntime,
		workflowRuntime,
		config,
		workflow,
		runner,
		logger,
		langfuse,
		clock = systemClock(),
		runShell = realRunShell,
	} = opts;
	const { defaults } = config;
	const agentEnv = resolveAgentEnvironment(config.agent.env);
	const logDir = resolvePath(process.cwd(), defaults.log_dir);
	const agent = opts.agent ?? claudeSdkAgentInvoker({ env: agentEnv, logDir });

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
		trackerRuntime,
		codeHost,
		codeHostRuntime,
		workflowRuntime,
		agent,
		clock,
		runShell,
		logger,
		workspaceRoot: defaults.workspace_root,
		skillsSourceDir: SKILLS_SOURCE_DIR,
		agentEnv,
		langfuseHost: langfuse.host,
		langfuseProjectId: langfuse.projectId,
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
			const result = await trackerRuntime.runPromise(
				tracker.fetchActiveIssues("pending"),
			);
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
					const result = await trackerRuntime.runPromise(
						tracker.fetchActiveIssues("running"),
					);
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
						trackerRuntime.runPromise(
							tracker.transitionState(
								issue.repo,
								issue.number,
								"running",
								"pending",
							),
						),
					),
				);
				for (const [index, r] of results.entries()) {
					if (r.status !== "rejected") continue;
					const issue = runningIssues[index];
					if (!issue) continue;
					logTransitionFailed(
						issue.repo,
						issue.number,
						"running",
						"pending",
						r.reason,
					);
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

	function reconcileQueue(state: TickState): void {
		const pendingByKey = new Map(state.pending.map((i) => [i.key, i]));

		for (const key of holdingQueue.keys()) {
			if (!pendingByKey.has(key) || state.runningIssueKeys.has(key)) {
				holdingQueue.delete(key);
			}
		}

		const nowIso = new Date(clock.now()).toISOString();
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

	async function dispatchFromQueue(state: TickState): Promise<DispatchTally> {
		const tally: DispatchTally = {
			dispatched: 0,
			skippedAtCapacity: 0,
		};
		for (const entry of [...holdingQueue.values()]) {
			const { issue } = entry;
			if (state.runningIssueKeys.has(issue.key)) continue;
			if (state.runningIssueKeys.size >= defaults.max_concurrent) {
				tally.skippedAtCapacity += 1;
				continue;
			}

			const { repo } = issue;
			try {
				await trackerRuntime.runPromise(
					tracker.transitionState(repo, issue.number, "pending", "running"),
				);
			} catch (err) {
				logTransitionFailed(repo, issue.number, "pending", "running", err);
				continue;
			}

			try {
				const handle = await lifecycle.dispatch({ issue, repo, workflow });
				trackPostRun(handle.result);
			} catch (err) {
				canonicalLog.append("warnings", {
					kind: "dispatch_failed",
					issue_key: issue.key,
					error: err instanceof Error ? err.message : String(err),
				});
				await trackerRuntime
					.runPromise(
						tracker.transitionState(repo, issue.number, "running", "pending"),
					)
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

			holdingQueue.delete(issue.key);
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
					reconcileQueue(state);
					canonicalLog.set({ queued_count: holdingQueue.size });
					const tally = await dispatchFromQueue(state);
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
			sweepWorkspaces(defaults.workspace_root, WORKSPACE_TTL_MS).then(
				(swept) => {
					if (swept.removed.length > 0) {
						logger.info(
							{ count: swept.removed.length },
							"orchestrator.workspaces_swept",
						);
					}
				},
				(err) => logger.warn({ err }, "orchestrator.workspace_sweep_failed"),
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
