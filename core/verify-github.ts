/**
 * Hono middleware that verifies GitHub webhook signatures.
 *
 * Reads the raw body, verifies the HMAC-SHA256 signature against
 * the provided secret, and stores the parsed payload in context.
 */
import { createMiddleware } from "hono/factory";
import { createHmac, timingSafeEqual } from "node:crypto";

export type WebhookVariables = {
  webhookPayload: Record<string, unknown>;
};

export function verifyGitHubWebhook(secret: string) {
  return createMiddleware<{ Variables: WebhookVariables }>(async (c, next) => {
    const body = await c.req.text();
    const signature = c.req.header("x-hub-signature-256");
    const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

    const valid =
      signature &&
      expected.length === signature.length &&
      timingSafeEqual(Buffer.from(signature), Buffer.from(expected));

    if (!valid) {
      return c.text("Invalid signature", 401);
    }

    c.set("webhookPayload", JSON.parse(body));
    await next();
  });
}
