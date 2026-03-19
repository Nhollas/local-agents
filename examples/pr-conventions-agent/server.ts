/**
 * PR Conventions Agent.
 *
 * /check — find codebase convention violations in a PR
 * /go    — implement selected fixes
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import {
  verifyGitHubWebhook,
  type WebhookVariables,
} from "../../core/verify-github.ts";
import { loadConventionsEnv } from "../../core/env.ts";
import {
  deleteComment,
  findReviewComment,
  parseCheckedItems,
  postReply,
  isPrOpen,
  getPrDetails,
} from "../../core/gh.ts";
import { logger } from "../../core/logger.ts";
import { loadJob } from "./storage.ts";
import { runCheck } from "./check.ts";
import { implementFindings } from "./implement.ts";

const issueCommentPayload = z.object({
  action: z.string(),
  comment: z.object({ id: z.number(), body: z.string() }),
  issue: z.object({
    number: z.number(),
    pull_request: z.unknown().refine((v) => v != null, "Must be a PR comment"),
  }),
  repository: z.object({ full_name: z.string() }),
});

const config = loadConventionsEnv();

const app = new Hono<{ Variables: WebhookVariables }>();

app.post("/webhook", verifyGitHubWebhook(config.GITHUB_WEBHOOK_SECRET), async (c) => {
  const event = c.req.header("x-github-event");
  const payload = c.get("webhookPayload");

  if (event !== "issue_comment") return c.text("Ignored", 200);
  if (payload.action !== "created") return c.text("Ignored", 200);

  const parsed = issueCommentPayload.safeParse(payload);
  if (!parsed.success) return c.text("Not a PR comment", 200);

  const { comment, issue, repository } = parsed.data;
  const command = comment.body.trim().toLowerCase();
  const repo = repository.full_name;
  const prNumber = issue.number;

  const triggerCommentId = comment.id;

  if (command === "/check") {
    logger.info({ repo, prNumber, command }, "webhook.command");
    handleCheck(repo, prNumber, triggerCommentId).catch((err) => {
      logger.error({ repo, prNumber, err }, "webhook.handler_failed");
    });
    return c.text("Processing", 202);
  }

  if (command === "/go") {
    logger.info({ repo, prNumber, command }, "webhook.command");
    handleGo(repo, prNumber, triggerCommentId).catch((err) => {
      logger.error({ repo, prNumber, err }, "webhook.handler_failed");
    });
    return c.text("Processing", 202);
  }

  return c.text("Ignored", 200);
});

async function handleCheck(repo: string, prNumber: number, triggerCommentId: number) {
  await deleteComment(repo, triggerCommentId).catch(() => {});

  if (!(await isPrOpen(repo, prNumber))) return;

  const existingJob = await loadJob(config.DATA_DIR, repo, prNumber);
  if (existingJob?.status === "checking" || existingJob?.status === "implementing") {
    await postReply(repo, prNumber, "A check or implementation is already running. Please wait.");
    return;
  }

  const { headBranch, baseBranch } = await getPrDetails(repo, prNumber);
  await runCheck(repo, prNumber, headBranch, baseBranch, {
    model: config.MODEL,
    maxFindingsPerCheck: 10,
    workDir: config.WORK_DIR,
    dataDir: config.DATA_DIR,
  });
}

async function handleGo(repo: string, prNumber: number, triggerCommentId: number) {
  await deleteComment(repo, triggerCommentId).catch(() => {});

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

  const job = await loadJob(config.DATA_DIR, repo, prNumber);
  if (!job) {
    await postReply(repo, prNumber, "No stored check found. Run `/check` first.");
    return;
  }
  if (job.status === "implementing") {
    await postReply(repo, prNumber, "Already implementing. Please wait.");
    return;
  }

  const selectedFindings = job.findings.filter((f) =>
    checkedTitles.some((t) => t.toLowerCase() === f.title.toLowerCase())
  );
  for (const f of selectedFindings) f.selected = true;

  await implementFindings(job, selectedFindings, {
    model: config.MODEL,
    workDir: config.WORK_DIR,
    dataDir: config.DATA_DIR,
  });
}

app.get("/", (c) => c.text("PR Conventions Agent"));

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port, commands: ["/check", "/go"] }, "server.started");
});
