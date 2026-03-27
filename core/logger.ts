import pino from "pino";
import { z } from "zod";

const level = z
	.enum(["fatal", "error", "warn", "info", "debug", "trace"])
	.default("info")
	.parse(process.env.LOG_LEVEL);

export const logger = pino({
	level,
	transport: {
		target: "pino-pretty",
	},
});
