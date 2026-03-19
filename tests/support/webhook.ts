import { createHmac } from "node:crypto";

/** Create a signed webhook request for testing the gateway. */
export function createWebhookRequest(
  secret: string,
  event: string,
  payload: Record<string, unknown>,
): Request {
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  return new Request("http://localhost/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": "test-delivery-id",
      "x-hub-signature-256": signature,
    },
    body,
  });
}
