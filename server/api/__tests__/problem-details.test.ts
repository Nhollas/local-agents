import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { testLogger } from "../../testing/support/test-logger.ts";
import { createCanonicalLogMiddleware } from "../canonical-log-middleware.ts";
import {
	ProblemDetailsError,
	problemDetailsHandler,
	zodProblemHook,
} from "../problem-details.ts";
import type { AppEnv } from "../types.ts";

function createApp() {
	const app = new Hono<AppEnv>();
	app.use(createCanonicalLogMiddleware(testLogger));
	app.onError(problemDetailsHandler);

	app.get("/ok", (c) => c.json({ ok: true }));

	app.get("/known-error", () => {
		throw new ProblemDetailsError(400, "Something was wrong");
	});

	app.get("/unknown-error", () => {
		throw new Error("kaboom");
	});

	app.get("/with-extensions", () => {
		throw new ProblemDetailsError(404, "Not found", {
			resourceId: "abc-123",
		});
	});

	app.get(
		"/validated",
		zValidator("query", z.object({ name: z.string() }), zodProblemHook),
		(c) => c.json({ ok: true }),
	);

	return app;
}

describe("X-Request-Id", () => {
	it("sets the header on error responses", async () => {
		const app = createApp();

		const res = await app.request("/known-error");

		expect(res.headers.get("X-Request-Id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("generates a unique id per request", async () => {
		const app = createApp();

		const [first, second] = await Promise.all([
			app.request("/ok"),
			app.request("/ok"),
		]);

		expect(first.headers.get("X-Request-Id")).not.toBe(
			second.headers.get("X-Request-Id"),
		);
	});
});

describe("problemDetailsHandler", () => {
	it("formats ProblemDetailsError as RFC 9457 response", async () => {
		const app = createApp();

		const res = await app.request("/known-error");

		expect(res.status).toBe(400);
		expect(res.headers.get("content-type")).toContain("application/json");
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 400,
			title: "Bad Request",
			detail: "Something was wrong",
			requestId: expect.any(String),
		});
	});

	it("formats unexpected errors as opaque 500", async () => {
		const app = createApp();

		const res = await app.request("/unknown-error");

		expect(res.status).toBe(500);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 500,
			title: "Internal Server Error",
			detail: "Internal Server Error",
			requestId: expect.any(String),
		});
	});

	it("includes extensions in the response body", async () => {
		const app = createApp();

		const res = await app.request("/with-extensions");

		expect(res.status).toBe(404);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 404,
			title: "Not Found",
			detail: "Not found",
			resourceId: "abc-123",
			requestId: expect.any(String),
		});
	});

	it("includes the same requestId in header and body", async () => {
		const app = createApp();

		const res = await app.request("/known-error");
		const body = await res.json();

		expect(body.requestId).toBe(res.headers.get("X-Request-Id"));
	});
});

describe("zodProblemHook", () => {
	it("returns 422 with field errors for invalid input", async () => {
		const app = createApp();

		const res = await app.request("/validated");

		expect(res.status).toBe(422);
		expect(await res.json()).toEqual({
			type: "about:blank",
			status: 422,
			title: "Unprocessable Content",
			detail: "Validation failed",
			errors: [
				{
					field: "name",
					message: expect.stringContaining("expected string"),
				},
			],
			requestId: expect.any(String),
		});
	});
});
