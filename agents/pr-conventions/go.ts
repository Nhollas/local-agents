import { defineAgent } from "../../core/define-agent.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  findReviewComment,
  parseCheckedItems,
  isPrOpen,
  deleteComment,
  postReply,
} from "../../core/gh.ts";
import { logAgentMessage } from "../../core/agent-logging.ts";
import { loadJob, saveJob } from "./storage.ts";
import type { Finding } from "./types.ts";

const exec = promisify(execFile);
const WORK_DIR = process.env.WORK_DIR ?? "/tmp/pr-conventions-work";

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
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
   - After fixing, stage and commit with message: "fix: ${f.title.toLowerCase()}"`,
    )
    .join("\n\n");

  return `Fix the following convention violations. For each one, read the convention example first, then align the violation to match that same standard. One commit per finding. Run tests and lint after all commits, fix any failures, then push.

Dependencies are already installed.

${items}`;
}

export default defineAgent({
  name: "pr-conventions-go",
  triggers: [{ event: "issue_comment", action: "created", command: "/go" }],
  handler: async (ctx) => {
    const { repo, prNumber, logger: log } = ctx;

    // Delete the trigger comment
    const triggerCommentId = (ctx.payload.comment as Record<string, unknown>)?.id;
    if (typeof triggerCommentId === "number") {
      await deleteComment(repo, triggerCommentId).catch(() => {});
    }

    if (!(await isPrOpen(repo, prNumber))) return;

    const review = await findReviewComment(repo, prNumber);
    if (!review) {
      await postReply(repo, prNumber, "No conventions check found. Run `/check` first.");
      return;
    }

    const checkedTitles = parseCheckedItems(review.body);
    if (checkedTitles.length === 0) {
      await postReply(repo, prNumber, "No checkboxes ticked. Select findings then `/go` again.");
      return;
    }

    const job = loadJob(repo, prNumber);
    if (!job) {
      await postReply(repo, prNumber, "No stored check found. Run `/check` first.");
      return;
    }
    if (job.status === "implementing") {
      await postReply(repo, prNumber, "Already implementing. Please wait.");
      return;
    }

    const selectedFindings = job.findings.filter((f) =>
      checkedTitles.some((t) => t.toLowerCase() === f.title.toLowerCase()),
    );
    for (const f of selectedFindings) f.selected = true;

    const workDir = path.join(
      WORK_DIR,
      `${repo.replace("/", "-")}-${prNumber}-${Date.now()}`,
    );

    try {
      job.status = "implementing";
      job.updatedAt = new Date().toISOString();
      saveJob(job);

      await ctx.clone(workDir);
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
          model: ctx.model,
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
            "implement.agent_complete",
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
      saveJob(job);

      const implemented = selectedFindings.map((f) => `- ${f.title}`).join("\n");
      await postReply(
        repo,
        prNumber,
        `## Conventions fixes applied\n\nThe following fixes have been pushed:\n\n${implemented}`,
      );

      log.info({ elapsedMs: Date.now() - startTime }, "implement.complete");
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.updatedAt = new Date().toISOString();
      saveJob(job);

      log.error({ err: job.error }, "implement.failed");

      await postReply(
        repo,
        prNumber,
        `## Implementation failed\n\n\`\`\`\n${job.error}\n\`\`\`\n\nThe branch has been left in its last-good state.`,
      ).catch(() => {});

      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});
