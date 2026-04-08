import type { MiddlewareHandler } from "hono";
import * as canonicalLog from "../canonical-log.ts";

export const canonicalLogMiddleware: MiddlewareHandler = async (c, next) => {
	await canonicalLog.run(
		{
			scope: "http",
			method: c.req.method,
			path: c.req.path,
		},
		async () => {
			await next();
			canonicalLog.set({ status: c.res.status });
		},
	);
};
