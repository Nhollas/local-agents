import { defineAgent } from "../../core/define-agent.ts";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rm } from "node:fs/promises";
import {
  findReviewComment,
  updateComment,
  getPrDetails,
  isPrOpen,
  deleteComment,
} from "../../core/gh.ts";
import { logAgentMessage } from "../../core/agent-logging.ts";
import { saveJob } from "./storage.ts";
import type { Finding, ReviewJob } from "./types.ts";

const WORK_DIR = process.env.WORK_DIR ?? "/tmp/pr-conventions-work";
const MAX_FINDINGS = 10;

/** Format findings into the checkbox markdown comment. */
function formatComment(reviewId: string, findings: Finding[]): string {
  if (findings.length === 0) {
    return [
      "## Conventions Check",
      "",
      "This PR follows the existing codebase conventions. No issues found.",
      "",
      `<!-- agent:review-id:${reviewId} -->`,
    ].join("\n");
  }

  const items = findings.map((f) => {
    const location = `\`${f.violation.path}:${f.violation.startLine}\``;
    const example = `\`${f.conventionExample.path}:${f.conventionExample.startLine}\``;
    return `- [ ] **${f.title}** (${location})\n  ${f.description} See ${example} for an example.`;
  });

  return [
    "## Conventions Check",
    "",
    ...items,
    "",
    "---",
    "*Fix these manually or tick the checkboxes and reply `/go` to apply fixes automatically.*",
    `<!-- agent:review-id:${reviewId} -->`,
  ].join("\n");
}

function formatRunningComment(reviewId: string): string {
  return [
    "## Conventions Check",
    "",
    "Running conventions check...",
    "",
    `<!-- agent:review-id:${reviewId} -->`,
  ].join("\n");
}

function formatErrorComment(reviewId: string, error: string): string {
  return [
    "## Conventions Check Failed",
    "",
    "```",
    error,
    "```",
    "",
    `<!-- agent:review-id:${reviewId} -->`,
  ].join("\n");
}

const FINDINGS_SCHEMA = {
  type: "object" as const,
  properties: {
    findings: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          title: {
            type: "string" as const,
            description: "Short summary, e.g. 'Use the API client instead of raw fetch'",
          },
          description: {
            type: "string" as const,
            description: "Explanation of the violation and what the convention is",
          },
          violation: {
            type: "object" as const,
            properties: {
              path: { type: "string" as const },
              startLine: { type: "number" as const },
              endLine: { type: "number" as const },
            },
            required: ["path", "startLine", "endLine"] as const,
          },
          conventionExample: {
            type: "object" as const,
            properties: {
              path: { type: "string" as const },
              startLine: { type: "number" as const },
              endLine: { type: "number" as const },
            },
            required: ["path", "startLine", "endLine"] as const,
          },
        },
        required: ["title", "description", "violation", "conventionExample"] as const,
      },
    },
  },
  required: ["findings"] as const,
};

type FindingsOutput = {
  findings: Array<{
    title: string;
    description: string;
    violation: { path: string; startLine: number; endLine: number };
    conventionExample: { path: string; startLine: number; endLine: number };
  }>;
};

function buildPrompt(diff: string, maxFindings: number): string {
  return `You are a conventions checker. Given the PR diff below, explore the codebase to find where the changes diverge from established patterns.

The codebase is the source of truth. Search for how the same things are already done — imports, structure, error handling, test coverage, naming. Flag where the PR doesn't match the clear majority pattern. Skip anything where the codebase is inconsistent itself.

New code should meet the same quality bar as the code it sits alongside.

For each finding, reference both the violation and a concrete convention example elsewhere in the codebase. Check for a .conventions file at the repo root for additional hints. Maximum ${maxFindings} findings.

\`\`\`diff
${diff}
\`\`\``;
}

export default defineAgent({
  name: "pr-conventions-check",
  triggers: [{ event: "issue_comment", action: "created", command: "/check" }],
  handler: async (ctx) => {
    const { repo, prNumber, logger: log } = ctx;

    // Delete the trigger comment
    const triggerCommentId = (ctx.payload.comment as Record<string, unknown>)?.id;
    if (typeof triggerCommentId === "number") {
      await deleteComment(repo, triggerCommentId).catch(() => {});
    }

    if (!(await isPrOpen(repo, prNumber))) return;

    const { headBranch, baseBranch } = await getPrDetails(repo, prNumber);
    const reviewId = randomUUID().slice(0, 8);
    const workDir = path.join(WORK_DIR, `check-${repo.replace("/", "-")}-${prNumber}-${Date.now()}`);

    // Post or update the review comment with a "running" state
    let commentId: number;
    const existing = await findReviewComment(repo, prNumber);
    if (existing) {
      await updateComment(repo, existing.commentId, formatRunningComment(reviewId));
      commentId = existing.commentId;
    } else {
      commentId = await ctx.comment(formatRunningComment(reviewId));
    }

    try {
      const diff = await ctx.diff();
      if (!diff) {
        await updateComment(repo, commentId, formatComment(reviewId, []));
        return;
      }

      await ctx.clone(workDir);

      const prompt = buildPrompt(diff, MAX_FINDINGS);
      let structuredOutput: unknown;
      const startTime = Date.now();

      log.info("check.started");

      for await (const msg of query({
        prompt,
        options: {
          cwd: workDir,
          model: ctx.model,
          settingSources: ["project"],
          allowedTools: ["Skill", "Read", "Glob", "Grep"],
          permissionMode: "dontAsk",
          outputFormat: { type: "json_schema", schema: FINDINGS_SCHEMA },
        },
      })) {
        if (msg.type === "assistant") {
          logAgentMessage(msg, workDir, ctx.emitToolUse);
        }

        if (msg.type === "result" && msg.subtype === "success") {
          structuredOutput = msg.structured_output;
          log.info(
            { elapsedMs: Date.now() - startTime, turns: msg.num_turns, costUsd: msg.total_cost_usd },
            "check.agent_complete",
          );
        }

        if (msg.type === "result" && msg.subtype !== "success") {
          log.error({ elapsedMs: Date.now() - startTime, subtype: msg.subtype }, "check.agent_failed");
        }
      }

      if (!structuredOutput) {
        throw new Error("Agent did not return structured output.");
      }

      const output = structuredOutput as FindingsOutput;
      const findings: Finding[] = output.findings.map((f) => ({
        id: randomUUID().slice(0, 8),
        ...f,
        selected: false,
        implemented: false,
      }));

      await updateComment(repo, commentId, formatComment(reviewId, findings));

      const job: ReviewJob = {
        id: reviewId,
        repo,
        prNumber,
        headBranch,
        baseBranch,
        commentId,
        findings,
        status: findings.length > 0 ? "awaiting_selection" : "done",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      saveJob(job);

      log.info(
        { elapsedMs: Date.now() - startTime, findingsCount: findings.length, commentId, reviewId },
        "check.complete",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err: message }, "check.failed");
      await updateComment(repo, commentId, formatErrorComment(reviewId, message)).catch(() => {});
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  },
});
