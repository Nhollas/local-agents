import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { logAgentMessage } from "./agent-logging.ts";
import { logger } from "./logger.ts";
import type { Runner } from "./runner.ts";
import type {
	CodeHostAdapter,
	Config,
	Issue,
	RepoWorkflow,
	TrackerAdapter,
} from "./types.ts";
import { renderPrompt } from "./workflow.ts";
import { ensureWorkspace } from "./workspace.ts";

const exec = promisify(execFile);

async function runShell(script: string, cwd: string): Promise<void> {
	await exec("sh", ["-c", script], { cwd });
}

type OrchestratorConfig = {
	tracker: TrackerAdapter;
	codeHost: CodeHostAdapter;
	config: Config;
	workflows: Map<string, RepoWorkflow>;
	runner: Runner;
};

export function createOrchestrator(opts: OrchestratorConfig) {
	const claimed = new Map<string, string>(); // issue.key -> runId
	let timer: ReturnType<typeof setInterval>;
	let ticking = false;

	function releaseClaim(runId: string) {
		for (const [key, id] of claimed) {
			if (id === runId) {
				claimed.delete(key);
				logger.info({ key, runId }, "orchestrator.claim_released");
				return;
			}
		}
	}

	async function tick() {
		if (ticking) return;
		ticking = true;

		try {
			const { tracker, codeHost, config, workflows, runner } = opts;
			const { defaults } = config;

			type TaggedIssue = { issue: Issue; repo: string; workflow: RepoWorkflow };

			// 1. FETCH issues from all repos with cached workflows
			const entries = [...workflows.entries()];
			const results = await Promise.allSettled(
				entries.map(async ([repo, workflow]) => {
					const issues = await tracker.fetchActiveIssues(repo, workflow.label);
					return issues.map(
						(issue): TaggedIssue => ({ issue, repo, workflow }),
					);
				}),
			);

			const allTagged: TaggedIssue[] = [];
			const fetchedRepos = new Set<string>();
			for (const [i, result] of results.entries()) {
				if (result.status === "fulfilled") {
					allTagged.push(...result.value);
					fetchedRepos.add(entries[i][0]);
				} else {
					logger.warn(
						{ repo: entries[i][0], err: result.reason },
						"orchestrator.fetch_failed",
					);
				}
			}

			// 2. SORT by createdAt ascending (oldest first)
			allTagged.sort((a, b) =>
				a.issue.createdAt.localeCompare(b.issue.createdAt),
			);

			// 3. RECONCILE: only for repos that were successfully fetched
			const activeKeys = new Set(allTagged.map((t) => t.issue.key));
			for (const [key, runId] of claimed) {
				const repo = key.slice(0, key.lastIndexOf("#"));
				if (fetchedRepos.has(repo) && !activeKeys.has(key)) {
					logger.info({ key, runId }, "orchestrator.reconcile_terminal");
					runner.kill(runId);
					claimed.delete(key);
				}
			}

			// 4. DISPATCH oldest-first up to max_concurrent
			for (const { issue, repo, workflow } of allTagged) {
				if (claimed.has(issue.key)) continue;
				if (claimed.size >= defaults.max_concurrent) break;

				const cloneUrl = codeHost.cloneUrl(repo);
				const prompt = renderPrompt(workflow.prompt, { issue });
				const ws = await ensureWorkspace(
					issue,
					defaults.workspace_root,
					cloneUrl,
					workflow.hooks,
				);

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

				const runId = runner.enqueue({
					name: `issue-${issue.number}`,
					issueKey: issue.key,
					issueTitle: issue.title,
					handler: async (emitToolUse) => {
						for await (const msg of query({
							prompt,
							options: {
								cwd: ws.path,
								model: defaults.model,
								allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
								permissionMode: "dontAsk",
							},
						})) {
							if (msg.type === "assistant") {
								logAgentMessage(msg, ws.path, emitToolUse);
							}
						}

						if (workflow.hooks?.after_run) {
							const script = renderPrompt(workflow.hooks.after_run, { issue });
							await runShell(script, ws.path);
						}
					},
				});

				claimed.set(issue.key, runId);
				logger.info({ issue: issue.key, runId }, "orchestrator.dispatched");
			}
		} finally {
			ticking = false;
		}
	}

	return {
		releaseClaim,
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
