/**
 * Implementation agent.
 *
 * Takes a list of convention findings and implements the fixes
 * in a sandboxed environment. One commit per finding.
 *
 * Repo setup (clone, install, config) is done deterministically
 * before the agent starts — the agent only makes code changes.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import { cloneAndCheckout, postReply } from "../../core/gh.ts";
import { logger } from "../../core/logger.ts";
import { logAgentMessage } from "../../core/agent-logging.ts";
import { saveJob } from "./storage.ts";
import type { Finding, ReviewJob } from "./types.ts";

const exec = promisify(execFile);

/** Run a command in a specific directory. */
async function run(
  cmd: string,
  args: string[],
  cwd: string
): Promise<string> {
  const { stdout } = await exec(cmd, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return stdout.trim();
}

function buildPrompt(findings: Finding[]): string {
  const items = findings
    .map(
      (f, i) =>
        `${i + 1}. **${f.title}**
   - Violation: \`${f.violation.path}:${f.violation.startLine}-${f.violation.endLine}\`
   - Convention example: \`${f.conventionExample.path}:${f.conventionExample.startLine}-${f.conventionExample.endLine}\`
   - Description: ${f.description}
   - After fixing, stage and commit with message: "fix: ${f.title.toLowerCase()}"`
    )
    .join("\n\n");

  return `Fix the following convention violations. For each one, read the convention example first, then align the violation to match that same standard. One commit per finding. Run tests and lint after all commits, fix any failures, then push.

Dependencies are already installed.

${items}`;
}

export async function implementFindings(
  job: ReviewJob,
  selectedFindings: Finding[],
  config: { model: string; workDir: string; dataDir: string }
): Promise<void> {
  const workDir = path.join(
    config.workDir,
    `${job.repo.replace("/", "-")}-${job.prNumber}-${Date.now()}`
  );
  const log = logger.child({
    event: "implement",
    repo: job.repo,
    prNumber: job.prNumber,
    findingsCount: selectedFindings.length,
  });

  try {
    job.status = "implementing";
    job.updatedAt = new Date().toISOString();
    await saveJob(config.dataDir, job);

    await cloneAndCheckout(job.repo, job.headBranch, workDir);
    await run("pnpm", ["install", "--frozen-lockfile"], workDir);
    await run("git", ["config", "user.name", "conventions-agent"], workDir);
    await run("git", ["config", "user.email", "conventions-agent@noreply"], workDir);

    const prompt = buildPrompt(selectedFindings);
    const startTime = Date.now();

    log.info("implement.started");

    for await (const msg of query({
      prompt,
      options: {
        cwd: workDir,
        model: config.model,
        allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        permissionMode: "dontAsk",
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
          excludedCommands: ["git push"],
          filesystem: {
            allowWrite: [workDir],
          },
          network: {
            allowLocalBinding: true,
            allowedDomains: ["github.com", "api.anthropic.com"],
          },
        },
      },
    })) {
      if (msg.type === "assistant") {
        logAgentMessage(msg, workDir);
      }

      if (msg.type === "result" && msg.subtype === "success") {
        log.info(
          { elapsedMs: Date.now() - startTime, turns: msg.num_turns, costUsd: msg.total_cost_usd },
          "implement.agent_complete"
        );
      }

      if (msg.type === "result" && msg.subtype !== "success") {
        log.error({ elapsedMs: Date.now() - startTime, subtype: msg.subtype }, "implement.agent_failed");
        throw new Error(`Agent failed: ${msg.subtype}`);
      }
    }

    for (const finding of selectedFindings) {
      finding.implemented = true;
    }

    job.status = "done";
    job.updatedAt = new Date().toISOString();
    await saveJob(config.dataDir, job);

    const implemented = selectedFindings.map((f) => `- ${f.title}`).join("\n");
    await postReply(
      job.repo,
      job.prNumber,
      `## Conventions fixes applied\n\nThe following fixes have been pushed:\n\n${implemented}`
    );

    log.info({ elapsedMs: Date.now() - startTime }, "implement.complete");
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.updatedAt = new Date().toISOString();
    await saveJob(config.dataDir, job);

    log.error({ err: job.error }, "implement.failed");

    await postReply(
      job.repo,
      job.prNumber,
      `## Implementation failed\n\n\`\`\`\n${job.error}\n\`\`\`\n\nThe branch has been left in its last-good state.`
    ).catch(() => {});

    throw err;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
