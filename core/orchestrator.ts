import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TrackerAdapter, WorkflowDefinition, Issue } from "./types.ts";
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
  workflow: WorkflowDefinition;
  runner: Runner;
};

export function createOrchestrator(config: OrchestratorConfig) {
  const claimed = new Map<number, string>(); // issueNumber -> runId
  let timer: ReturnType<typeof setInterval>;
  let ticking = false;

  function releaseClaim(runId: string) {
    for (const [issueNumber, id] of claimed) {
      if (id === runId) {
        claimed.delete(issueNumber);
        logger.info({ issueNumber, runId }, "orchestrator.claim_released");
        return;
      }
    }
  }

  async function tick() {
    if (ticking) return;
    ticking = true;

    try {
      const { tracker, workflow, runner } = config;
      const { config: wfConfig } = workflow;

      // 1. FETCH active issues (single API call)
      const issues = await tracker.fetchActiveIssues(
        wfConfig.tracker.repo,
        wfConfig.tracker.label,
      );
      const activeNumbers = new Set(issues.map((i) => i.number));

      // 2. RECONCILE: kill claimed issues that are no longer active
      for (const [issueNumber, runId] of claimed) {
        if (!activeNumbers.has(issueNumber)) {
          logger.info({ issueNumber, runId }, "orchestrator.reconcile_terminal");
          runner.kill(runId);
          claimed.delete(issueNumber);
        }
      }

      // 3. DISPATCH eligible issues
      for (const issue of issues) {
        if (claimed.has(issue.number)) continue;
        if (claimed.size >= wfConfig.agent.max_concurrent) break;

        const prompt = renderPrompt(workflow.prompt, { issue });
        const ws = await ensureWorkspace(issue, wfConfig.workspace.root, wfConfig.hooks);

        if (wfConfig.hooks?.before_run) {
          const script = renderPrompt(wfConfig.hooks.before_run, { issue });
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
                model: wfConfig.agent.model,
                allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
                permissionMode: "dontAsk",
              },
            })) {
              if (msg.type === "assistant") {
                logAgentMessage(msg, ws.path, emitToolUse);
              }
            }

            if (wfConfig.hooks?.after_run) {
              const script = renderPrompt(wfConfig.hooks.after_run, { issue });
              await runShell(script, ws.path);
            }
          },
        });

        claimed.set(issue.number, runId);
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
        { interval: config.workflow.config.polling.interval_ms },
        "orchestrator.starting",
      );
      tick().catch((err) => logger.error({ err }, "orchestrator.tick_failed"));
      timer = setInterval(
        () => tick().catch((err) => logger.error({ err }, "orchestrator.tick_failed")),
        config.workflow.config.polling.interval_ms,
      );
    },
    stop() {
      clearInterval(timer);
    },
  };
}
