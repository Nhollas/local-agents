import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { eq } from "drizzle-orm";
import { logAgentMessage } from "./agent-logging.ts";
import type { Db } from "./db.ts";
import { logger } from "./logger.ts";
import type { AgentJob, Runner } from "./runner.ts";
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

	function buildAgentJob(jobOpts: {
		issue: Issue;
		repo: string;
		workflow: RepoWorkflow;
		wsPath: string;
		prompt: string;
		attempt: number;
		parentRunId?: string;
		resumeSessionId?: string;
	}): AgentJob {
		const { issue, repo, workflow, wsPath, prompt, attempt } = jobOpts;

		return {
			name: `issue-${issue.number}`,
			issueKey: issue.key,
			issueTitle: issue.title,
			attempt,
			parentRunId: jobOpts.parentRunId,
			maxRetries: defaults.max_retries,
			handler: async (emitToolUse, setSessionId) => {
				const agentOptions: Record<string, unknown> = {
					cwd: wsPath,
					model: defaults.model,
					allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
					permissionMode: "dontAsk",
				};

				if (jobOpts.resumeSessionId) {
					agentOptions.resume = jobOpts.resumeSessionId;
				}

				for await (const msg of runAgent({
					prompt,
					options: agentOptions as Parameters<typeof query>[0]["options"],
				})) {
					if (msg.type === "assistant") {
						logAgentMessage(msg, wsPath, emitToolUse);
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
					await runShell(script, wsPath);
				}
			},
			onComplete: async () => {
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
			},
			onFinally: async () => {
				await removeWorkspace(wsPath);

				const retriesExhausted = (defaults.max_retries ?? 0) - attempt < 0;
				if (retriesExhausted) {
					await tracker
						.swapLabel(repo, issue.number, LABELS.running, LABELS.pending)
						.catch((err) =>
							logger.warn(
								{ issue: issue.key, err },
								"orchestrator.label_rollback_failed",
							),
						);
				}
			},
		};
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			// 1. FETCH pending issues + running-label check (in parallel)
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

			// 2. RECONCILE: kill agents whose issues no longer have the running label
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

			// 3. DISPATCH oldest-first up to max_concurrent
			for (const { issue, repo, workflow } of allTagged) {
				if (runningByIssue.has(issue.key)) continue;
				if (runningCount >= defaults.max_concurrent) break;

				// Claim the issue so the next tick can never re-dispatch it.
				await tracker.swapLabel(
					repo,
					issue.number,
					LABELS.pending,
					LABELS.running,
				);

				let ws: Awaited<ReturnType<typeof ensureWorkspace>>;
				try {
					const cloneUrl = codeHost.cloneUrl(repo);
					ws = await ensureWorkspace(
						issue,
						defaults.workspace_root,
						cloneUrl,
						workflow.hooks,
					);
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

				const prompt = renderPrompt(workflow.prompt, { issue });

				if (workflow.hooks?.before_run) {
					const script = renderPrompt(workflow.hooks.before_run, { issue });
					try {
						await runShell(script, ws.path);
					} catch (err) {
						logger.warn(
							{ issue: issue.key, err },
							"orchestrator.before_run_failed",
						);
					}
				}

				const job = buildAgentJob({
					issue,
					repo,
					workflow,
					wsPath: ws.path,
					prompt,
					attempt: 1,
				});
				runner.enqueue(job);

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

		const job = buildAgentJob({
			issue,
			repo,
			workflow,
			wsPath: ws.path,
			prompt,
			attempt,
			parentRunId: failedRunId,
			resumeSessionId: failedRun.sessionId,
		});

		const runId = runner.enqueue(job);
		logger.info(
			{ issue: issue.key, attempt, parentRunId: failedRunId },
			"orchestrator.retry_dispatched",
		);

		return { runId };
	}

	return {
		tick,
		retryRun,
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
