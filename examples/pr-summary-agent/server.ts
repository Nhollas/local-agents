/**
 * PR Summary Agent.
 *
 * Listens for PR creation and posts a concise summary of what changed.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import {
  verifyGitHubWebhook,
  type WebhookVariables,
} from "../../lib/verify-github.ts";
import { loadWebhookEnv } from "../../lib/env.ts";
import { logger } from "../../lib/logger.ts";
import { summarisePr } from "./summarise.ts";

const pullRequestPayload = z.object({
  action: z.string(),
  pull_request: z.object({ number: z.number() }),
  repository: z.object({ full_name: z.string() }),
});

const config = loadWebhookEnv();

const app = new Hono<{ Variables: WebhookVariables }>();

app.post("/webhook", verifyGitHubWebhook(config.GITHUB_WEBHOOK_SECRET), async (c) => {
  const event = c.req.header("x-github-event");
  const payload = c.get("webhookPayload");

  if (event !== "pull_request") return c.text("Ignored", 200);
  if (payload.action !== "opened") return c.text("Ignored", 200);

  const parsed = pullRequestPayload.safeParse(payload);
  if (!parsed.success) return c.text("Missing PR data", 400);

  const { repository, pull_request } = parsed.data;
  const repo = repository.full_name;
  const prNumber = pull_request.number;

  logger.info({ repo, prNumber }, "webhook.pr_opened");

  summarisePr(repo, prNumber, config.MODEL).catch((err) => {
    logger.error({ repo, prNumber, err }, "webhook.handler_failed");
  });

  return c.text("Processing", 202);
});

app.get("/", (c) => c.text("PR Summary Agent"));

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, "server.started");
});
