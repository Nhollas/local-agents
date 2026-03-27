import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TrackerAdapter, Config, RepoWorkflow } from "./types.ts";
import type { Runner } from "./runner.ts";
import { ensureWorkspace } from "./workspace.ts";
import { renderPrompt } from "./workflow.ts";
import { logAgentMessage } from "./agent-logging.ts";
import { logger } from "./logger.ts";

const exec = promisify(execFile);

async function runShell(script: string, cwd: string): Promise<void> {
  await exec("sh", ["-c", script], { cwd });
}

type OrchestratorConfig = {
  tracker: TrackerAdapter;
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
      const { tracker, config, workflows, runner } = opts;
      const { defaults } = config;

      for (const [repo, workflow] of workflows) {
        const issues = await tracker.fetchActiveIssues(repo, workflow.label);
        const activeKeys = new Set(issues.map((i) => i.key));

        const repoPrefix = `${repo}#`;
        for (const [key, runId] of claimed) {
          if (key.startsWith(repoPrefix) && !activeKeys.has(key)) {
            logger.info({ key, runId }, "orchestrator.reconcile_terminal");
            runner.kill(runId);
            claimed.delete(key);
          }
        }

        for (const issue of issues) {
          if (claimed.has(issue.key)) continue;
          if (claimed.size >= defaults.max_concurrent) return;

          const prompt = renderPrompt(workflow.prompt, { issue });
          const ws = await ensureWorkspace(issue, defaults.workspace_root, workflow.hooks);

          if (workflow.hooks?.before_run) {
            const script = renderPrompt(workflow.hooks.before_run, { issue });
            try {
              await runShell(script, ws.path);
            } catch (err) {
              logger.warn({ issue: issue.key, err }, "orchestrator.before_run_failed");
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
        () => tick().catch((err) => logger.error({ err }, "orchestrator.tick_failed")),
        opts.config.defaults.polling_interval_ms,
      );
    },
    stop() {
      clearInterval(timer);
    },
  };
}
