import pino, { type Logger } from "pino";
import type { LogLevel } from "./config/env.ts";

export type { Logger };

export function createLogger(level: LogLevel): Logger {
	// Skip the pino-pretty transport at silent level; it spawns a worker
	// thread that would do nothing but cost startup time per logger.
	if (level === "silent") return pino({ level });
	return pino({
		level,
		transport: {
			target: "pino-pretty",
		},
	});
}
