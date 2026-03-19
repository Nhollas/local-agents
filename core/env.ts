/**
 * Environment variable validation with Zod.
 *
 * Each agent calls its loader at startup. If any required
 * variable is missing or invalid, the process exits with
 * a clear error message.
 */
import "dotenv/config";
import { z } from "zod";

export function parseEnv<T extends z.ZodTypeAny>(schema: T): z.infer<T> {
  const result = schema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`Invalid environment variables:\n${issues}`);
    process.exit(1);
  }

  return result.data;
}

const gatewayEnvSchema = z.object({
  GITHUB_WEBHOOK_SECRET: z.string().min(1, "Required"),
  PORT: z.coerce.number().default(3000),
  MODEL: z.string().default("claude-sonnet-4-6"),
});

const conventionsEnvSchema = gatewayEnvSchema.extend({
  WORK_DIR: z.string().default("/tmp/pr-conventions-work"),
  DATA_DIR: z.string().default(".data"),
});

export function loadGatewayEnv() {
  return parseEnv(gatewayEnvSchema);
}

export function loadConventionsEnv() {
  return parseEnv(conventionsEnvSchema);
}
