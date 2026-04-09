import type { MiddlewareHandler } from "hono";
import * as canonicalLog from "../canonical-log.ts";
import type { AppEnv } from "./types.ts";

export const canonicalLogMiddleware: MiddlewareHandler<AppEnv> = async (
	c,
	next,
) => {
	const requestId = crypto.randomUUID();
	c.set("requestId", requestId);
	c.header("X-Request-Id", requestId);

	await canonicalLog.run(
		{
			scope: "http",
			request_id: requestId,
			method: c.req.method,
			path: c.req.path,
		},
		async () => {
			await next();
			canonicalLog.set({ status: c.res.status });
		},
	);
};
