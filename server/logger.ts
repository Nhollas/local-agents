import pino from "pino";
import { z } from "zod";

import { loadEnv } from "./env.ts";

const env = loadEnv();

const level = z
	.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
	.default("info")
	.parse(env.LOG_LEVEL);

export const logger = pino({
	level,
	transport: {
		target: "pino-pretty",
	},
});
