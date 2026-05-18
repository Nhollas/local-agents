import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types.ts";

export const requestIdMiddleware: MiddlewareHandler<AppEnv> = async (
	c,
	next,
) => {
	const requestId = crypto.randomUUID();
	c.set("requestId", requestId);
	c.header("X-Request-Id", requestId);
	await next();
};
