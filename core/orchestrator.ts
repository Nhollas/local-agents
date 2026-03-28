import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { logAgentMessage } from "./agent-logging.ts";
import type { Db } from "./db.ts";
import { logger } from "./logger.ts";
import type { Runner, RunResult } from "./runner.ts";
import { runs } from "./schema.ts";
import type {
	CodeHostAdapter,
	Config,
	Issue,
	RepoWorkflow,
	TrackerAdapter,
} from "./types.ts";
import { renderPrompt } from "./workflow.ts";
import { ensureWorkspace, removeWorkspace } from "./workspace.ts";

const exec = promisify(execFile);

const LABELS = {
	pending: "agent",
	running: "agent:running",
	completed: "agent:awaiting-review",
} as const;

function repoFromKey(key: string): string {
	return key.slice(0, key.lastIndexOf("#"));
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
	db: Db;
	tracker: TrackerAdapter;
	codeHost: CodeHostAdapter;
	config: Config;
	workflows: Map<string, RepoWorkflow>;
	runner: Runner;
	runAgent?: RunAgent;
};

type RunSnapshot = { id: string; issueKey: string };
type TaggedIssue = { issue: Issue; repo: string; workflow: RepoWorkflow };

function getRunSnapshot(db: Db): RunSnapshot[] {
	return db
		.select({
			id: runs.id,
			issueKey: runs.issueKey,
		})
		.from(runs)
		.where(eq(runs.status, "running"))
		.all()
		.filter((r): r is RunSnapshot => r.issueKey !== null);
}

export function createOrchestrator(opts: OrchestratorConfig) {
	let timer: ReturnType<typeof setInterval>;
	let ticking = false;
	const pendingPostRuns = new Set<Promise<void>>();

	const {
		db,
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
			try {
				await runShell(script, ws.path);
			} catch (err) {
				logger.warn(
					{ issue: issue.key, err },
					"orchestrator.before_run_failed",
				);
			}
		}

		const prompt = renderPrompt(workflow.prompt, { issue, attempt });

		const { runId, done } = runner.enqueue({
			name: `issue-${issue.number}`,
			issueKey: issue.key,
			issueTitle: issue.title,
			attempt,
			parentRunId: params.parentRunId,
			handler: async (emitToolUse, setSessionId) => {
				const agentOptions: Record<string, unknown> = {
					cwd: ws.path,
					model: defaults.model,
					allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
					permissionMode: "dontAsk",
				};

				if (params.resumeSessionId) {
					agentOptions.resume = params.resumeSessionId;
				}

				for await (const msg of runAgent({
					prompt,
					options: agentOptions as Parameters<typeof query>[0]["options"],
				})) {
					if (msg.type === "assistant") {
						logAgentMessage(msg, ws.path, emitToolUse);
						if ("session_id" in msg && typeof msg.session_id === "string") {
							setSessionId(msg.session_id);
						}
					}
				}

				if (workflow.hooks?.after_run) {
					const script = renderPrompt(workflow.hooks.after_run, {
						issue,
						attempt,
					});
					await runShell(script, ws.path);
				}
			},
		});

		const postRun = handlePostRun(done, {
			issue,
			repo,
			workflow,
			wsPath: ws.path,
			attempt,
		});
		pendingPostRuns.add(postRun);
		postRun.finally(() => pendingPostRuns.delete(postRun));

		return runId;
	}

	async function handlePostRun(
		done: Promise<RunResult>,
		ctx: {
			issue: Issue;
			repo: string;
			workflow: RepoWorkflow;
			wsPath: string;
			attempt: number;
		},
	) {
		const result = await done;

		if (result.status === "completed") {
			try {
				const head = renderPrompt(ctx.workflow.branch, {
					issue: ctx.issue,
				});
				await codeHost.createChangeRequest(
					ctx.repo,
					head,
					ctx.workflow.base_branch,
					ctx.issue.title,
					`Closes ${ctx.issue.key}`,
				);

				await tracker.swapLabel(
					ctx.repo,
					ctx.issue.number,
					LABELS.running,
					LABELS.completed,
				);
			} catch (err) {
				logger.error(
					{
						agent: `issue-${ctx.issue.number}`,
						runId: "unknown",
						err: err instanceof Error ? err.message : String(err),
					},
					"orchestrator.on_complete_failed",
				);
			}
		}

		const retriesExhausted = (defaults.max_retries ?? 0) - ctx.attempt < 0;
		const shouldCleanup = result.status === "completed" || retriesExhausted;

		if (shouldCleanup) {
			await removeWorkspace(ctx.wsPath);
		}

		if (result.status === "failed" && retriesExhausted) {
			await tracker
				.swapLabel(ctx.repo, ctx.issue.number, LABELS.running, LABELS.pending)
				.catch((err) =>
					logger.warn(
						{ issue: ctx.issue.key, err },
						"orchestrator.label_rollback_failed",
					),
				);
		}
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			const entries = [...workflows.entries()];

			const snapshot = getRunSnapshot(db);
			const runningByIssue = new Map<string, string[]>();
			for (const r of snapshot) {
				const ids = runningByIssue.get(r.issueKey) ?? [];
				ids.push(r.id);
				runningByIssue.set(r.issueKey, ids);
			}
			let runningCount = snapshot.length;

			const reposWithRunning = new Set(
				[...runningByIssue.keys()].map((k) => repoFromKey(k)),
			);

			const [pendingResults, runningResults] = await Promise.all([
				Promise.allSettled(
					entries.map(async ([repo, workflow]) => {
						const issues = await tracker.fetchActiveIssues(
							repo,
							LABELS.pending,
						);
						return issues.map(
							(issue): TaggedIssue => ({ issue, repo, workflow }),
						);
					}),
				),
				runningByIssue.size > 0
					? Promise.allSettled(
							entries
								.filter(([repo]) => reposWithRunning.has(repo))
								.map(async ([repo]) => {
									const issues = await tracker.fetchActiveIssues(
										repo,
										LABELS.running,
									);
									return { repo, keys: new Set(issues.map((i) => i.key)) };
								}),
						)
					: Promise.resolve([]),
			]);

			const allTagged: TaggedIssue[] = [];
			for (const result of pendingResults) {
				if (result.status === "fulfilled") {
					allTagged.push(...result.value);
				}
			}

			allTagged.sort((a, b) =>
				a.issue.createdAt.localeCompare(b.issue.createdAt),
			);

			// Reconcile: kill agents whose issues no longer have the running label
			const stillRunning = new Map<string, Set<string>>();
			for (const result of runningResults) {
				if (result.status === "fulfilled") {
					stillRunning.set(result.value.repo, result.value.keys);
				}
			}

			for (const [key, runIds] of runningByIssue) {
				const repo = repoFromKey(key);
				const repoKeys = stillRunning.get(repo);
				if (repoKeys && !repoKeys.has(key)) {
					logger.info({ key }, "orchestrator.reconcile_terminal");
					for (const id of runIds) {
						runner.kill(id);
					}
				}
			}

			// Dispatch oldest-first up to max_concurrent
			for (const { issue, repo, workflow } of allTagged) {
				if (runningByIssue.has(issue.key)) continue;
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
					logger.warn(
						{ issue: issue.key, err },
						"orchestrator.dispatch_failed",
					);
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
				runningByIssue.set(issue.key, []);
				logger.info({ issue: issue.key }, "orchestrator.dispatched");
			}
		} finally {
			ticking = false;
		}
	}

	async function retryRun(
		failedRunId: string,
	): Promise<{ runId: string } | { error: string }> {
		const failedRun = db
			.select()
			.from(runs)
			.where(eq(runs.id, failedRunId))
			.get();
		if (!failedRun) return { error: "Run not found" };
		if (failedRun.status !== "failed") return { error: "Run is not failed" };
		if (!failedRun.sessionId) return { error: "No session to resume" };
		if (!failedRun.issueKey) return { error: "No issue key" };

		const attempt = (failedRun.attempt ?? 1) + 1;
		if (attempt > defaults.max_retries + 1)
			return { error: "Max retries exceeded" };

		const snapshot = getRunSnapshot(db);
		if (snapshot.some((r) => r.issueKey === failedRun.issueKey)) {
			return { error: "Issue already has a running agent" };
		}

		const repo = repoFromKey(failedRun.issueKey);
		const workflow = workflows.get(repo);
		if (!workflow) return { error: "No workflow for repo" };

		const issueNumber = Number.parseInt(failedRun.issueKey.split("#")[1], 10);
		const issue: Issue = {
			key: failedRun.issueKey,
			number: issueNumber,
			title: failedRun.issueTitle ?? "",
			description: "",
			labels: [],
			url: "",
			createdAt: "",
		};

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
		/** Wait for all post-run work (PR creation, label swaps, cleanup) to finish. */
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
