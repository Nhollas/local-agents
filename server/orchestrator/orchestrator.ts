import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import * as canonicalLog from "../canonical-log.ts";
import type { CodeHostAdapter } from "../code-hosts/types.ts";
import type { Config } from "../config.ts";
import { logger } from "../logger.ts";
import type { RunRepository } from "../run-repository.ts";
import { ABORT_ERROR, type Runner, type RunResult } from "../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../trackers/types.ts";
import type { RepoWorkflow } from "../workflow/workflow.ts";
import { renderPrompt } from "../workflow/workflow.ts";
import { logAgentMessage } from "./agent-logging.ts";
import { ensureWorkspace, removeWorkspace } from "./workspace.ts";

const exec = promisify(execFile);

const LABELS = {
	pending: "agent",
	running: "agent:running",
	completed: "agent:awaiting-review",
} as const;

function parseIssueKey(key: string): { repo: string; number: number } {
	const hashIndex = key.lastIndexOf("#");
	return {
		repo: key.slice(0, hashIndex),
		number: Number.parseInt(key.slice(hashIndex + 1), 10),
	};
}

async function runShell(script: string, cwd: string): Promise<void> {
	await exec("sh", ["-c", script], { cwd });
}

type RunAgent = (
	params: Parameters<typeof query>[0],
) => AsyncIterable<
	ReturnType<typeof query> extends AsyncGenerator<infer T> ? T : never
>;

type OrchestratorConfig = {
	runRepo: RunRepository;
	tracker: TrackerAdapter;
	codeHost: CodeHostAdapter;
	config: Config;
	workflows: Map<string, RepoWorkflow>;
	runner: Runner;
	runAgent?: RunAgent;
};

type Orchestrator = {
	tick(): Promise<void>;
	retryRun(failedRunId: string): Promise<{ runId: string } | { error: string }>;
	/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
	settled(): Promise<void>;
	start(): void;
	stop(): void;
};

type TaggedIssue = { issue: Issue; repo: string; workflow: RepoWorkflow };
type TickState = {
	runningByIssue: Map<string, string[]>;
	runningCount: number;
	pending: TaggedIssue[];
	stillRunning: Map<string, Set<string>>;
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
		runAgent = query,
	} = opts;
	const { defaults } = config;

	async function prepareAndDispatch(params: {
		issue: Issue;
		repo: string;
		workflow: RepoWorkflow;
		attempt: number;
		parentRunId?: string;
		resumeSessionId?: string;
	}): Promise<string> {
		const { issue, repo, workflow, attempt } = params;

		const cloneUrl = codeHost.cloneUrl(repo);
		const ws = await ensureWorkspace(
			issue,
			defaults.workspace_root,
			cloneUrl,
			workflow.hooks,
		);

		if (workflow.hooks?.before_run) {
			const script = renderPrompt(workflow.hooks.before_run, {
				issue,
				attempt,
			});
			await runShell(script, ws.path);
		}

		const prompt = renderPrompt(workflow.prompt, { issue, attempt });

		const { runId, done } = runner.enqueue({
			name: `issue-${issue.number}`,
			issueKey: issue.key,
			issueTitle: issue.title,
			attempt,
			...(params.parentRunId != null && { parentRunId: params.parentRunId }),
			handler: async (ctx) => {
				return canonicalLog.run(
					{
						scope: "run",
						run_id: ctx.runId,
						agent: `issue-${issue.number}`,
						issue_key: issue.key,
						attempt: attempt,
					},
					async () => {
						const startTime = Date.now();
						let result: RunResult;

						try {
							const abortPromise = new Promise<never>((_, reject) => {
								ctx.signal.addEventListener("abort", () => {
									reject(new Error(ABORT_ERROR));
								});
							});

							await Promise.race([
								(async () => {
									const options = {
										cwd: ws.path,
										model: defaults.model,
										allowedTools: [
											"Read",
											"Write",
											"Edit",
											"Bash",
											"Glob",
											"Grep",
										],
										permissionMode: "dontAsk" as const,
										...(params.resumeSessionId && {
											resume: params.resumeSessionId,
										}),
									};

									for await (const msg of runAgent({
										prompt,
										options,
									})) {
										if (msg.type !== "assistant") continue;
										logAgentMessage(msg, ws.path, ctx.emitToolUse);
										ctx.setSessionId(msg.session_id);
									}

									if (workflow.hooks?.after_run) {
										const script = renderPrompt(workflow.hooks.after_run, {
											issue,
											attempt,
										});
										try {
											await runShell(script, ws.path);
										} catch (err) {
											canonicalLog.append(
												"warnings",
												`after_run_failed: ${canonicalLog.errorMessage(err)}`,
											);
										}
									}
								})(),
								abortPromise,
							]);

							result = {
								status: "completed",
								durationMs: Date.now() - startTime,
							};
						} catch (err) {
							result = {
								status: "failed",
								error: canonicalLog.errorMessage(err),
								durationMs: Date.now() - startTime,
							};
						}

						canonicalLog.set({
							status: result.status,
							...(result.status === "failed" && { error: result.error }),
						});

						// Post-run work — inside the canonical scope so decorators
						// and warnings are captured in the run's log line.
						if (result.status === "completed") {
							try {
								const head = renderPrompt(workflow.branch, { issue });
								await codeHost.createChangeRequest(
									repo,
									head,
									workflow.base_branch,
									issue.title,
									`Closes ${issue.key}`,
								);

								await tracker.swapLabel(
									repo,
									issue.number,
									LABELS.running,
									LABELS.completed,
								);
							} catch (err) {
								canonicalLog.append(
									"warnings",
									`on_complete_failed: ${canonicalLog.errorMessage(err)}`,
								);
								await tracker
									.swapLabel(
										repo,
										issue.number,
										LABELS.running,
										LABELS.completed,
									)
									.catch((labelErr) =>
										canonicalLog.append(
											"warnings",
											`label_recovery_failed: ${canonicalLog.errorMessage(labelErr)}`,
										),
									);
							}
						}

						const retriesExhausted = defaults.max_retries - attempt < 0;
						const shouldCleanup =
							result.status === "completed" || retriesExhausted;

						if (shouldCleanup) {
							await removeWorkspace(ws.path);
						}

						if (result.status === "failed" && retriesExhausted) {
							await tracker
								.swapLabel(repo, issue.number, LABELS.running, LABELS.pending)
								.catch((err) =>
									canonicalLog.append(
										"warnings",
										`label_rollback_failed: ${canonicalLog.errorMessage(err)}`,
									),
								);
						}

						return result;
					},
					logger,
				);
			},
		});

		pendingPostRuns.add(done);
		done.finally(() => pendingPostRuns.delete(done));

		return runId;
	}

	async function fetchTickState(): Promise<TickState> {
		const entries = [...workflows.entries()];

		const dbSnapshot = runRepo.getRunningSnapshot();
		const runningByIssue = new Map<string, string[]>();
		for (const r of dbSnapshot) {
			const ids = runningByIssue.get(r.issueKey) ?? [];
			ids.push(r.id);
			runningByIssue.set(r.issueKey, ids);
		}

		const [pendingResults, runningResults] = await Promise.all([
			Promise.allSettled(
				entries.map(async ([repo, workflow]) => {
					const issues = await tracker.fetchActiveIssues(repo, LABELS.pending);
					return issues.map(
						(issue): TaggedIssue => ({ issue, repo, workflow }),
					);
				}),
			),
			Promise.allSettled(
				entries.map(async ([repo]) => {
					const issues = await tracker.fetchActiveIssues(repo, LABELS.running);
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

		const stillRunning = new Map<string, Set<string>>();
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
			const { repo } = parseIssueKey(key);
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
				const { number } = parseIssueKey(key);
				logger.info({ key }, "orchestrator.reconcile_orphan");
				await tracker
					.swapLabel(repo, number, LABELS.running, LABELS.pending)
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

			await tracker.swapLabel(
				repo,
				issue.number,
				LABELS.pending,
				LABELS.running,
			);

			try {
				await prepareAndDispatch({ issue, repo, workflow, attempt: 1 });
			} catch (err) {
				logger.warn({ issue: issue.key, err }, "orchestrator.dispatch_failed");
				await tracker
					.swapLabel(repo, issue.number, LABELS.running, LABELS.pending)
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
		failedRunId: string,
	): Promise<{ runId: string } | { error: string }> {
		const failedRun = runRepo.getRunById(failedRunId);
		if (!failedRun) return { error: "Run not found" };
		if (failedRun.status !== "failed") return { error: "Run is not failed" };
		if (!failedRun.sessionId) return { error: "No session to resume" };
		if (!failedRun.issueKey) return { error: "No issue key" };

		const attempt = failedRun.attempt + 1;
		if (attempt > defaults.max_retries + 1)
			return { error: "Max retries exceeded" };

		const snapshot = runRepo.getRunningSnapshot();
		if (snapshot.some((r) => r.issueKey === failedRun.issueKey)) {
			return { error: "Issue already has a running agent" };
		}

		const { repo, number: issueNumber } = parseIssueKey(failedRun.issueKey);
		const workflow = workflows.get(repo);
		if (!workflow) return { error: "No workflow for repo" };

		const issue = await tracker.fetchIssue(repo, issueNumber);

		const runId = await prepareAndDispatch({
			issue,
			repo,
			workflow,
			attempt,
			parentRunId: failedRunId,
			resumeSessionId: failedRun.sessionId,
		});

		logger.info(
			{ issue: issue.key, attempt, parentRunId: failedRunId },
			"orchestrator.retry_dispatched",
		);

		return { runId };
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
