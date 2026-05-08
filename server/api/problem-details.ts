import type { Hook } from "@hono/zod-validator";
import type { Context, Env, ErrorHandler, ValidationTargets } from "hono";
import type { $ZodType } from "zod/v4/core";
import * as canonicalLog from "../canonical-log.ts";
import type { AppEnv } from "./types.ts";

const STATUS_TITLES = {
	400: "Bad Request",
	404: "Not Found",
	422: "Unprocessable Content",
	500: "Internal Server Error",
} as const;

type ProblemStatus = keyof typeof STATUS_TITLES;

export class ProblemDetailsError extends Error {
	readonly status: ProblemStatus;
	readonly detail: string;
	readonly extensions: Record<string, unknown>;

	constructor(
		status: ProblemStatus,
		detail: string,
		extensions: Record<string, unknown> = {},
	) {
		super(detail);
		this.name = "ProblemDetailsError";
		this.status = status;
		this.detail = detail;
		this.extensions = extensions;
	}
}

function buildProblemResponse(
	c: Context<AppEnv>,
	status: ProblemStatus,
	detail: string,
	extensions: Record<string, unknown> = {},
) {
	const requestId = c.get("requestId");

	const body = {
		type: "about:blank",
		status,
		title: STATUS_TITLES[status],
		detail,
		...(requestId && { requestId }),
		...extensions,
	};

	return c.json(body, status);
}

export const problemDetailsHandler: ErrorHandler<AppEnv> = (err, c) => {
	if (err instanceof ProblemDetailsError) {
		return buildProblemResponse(c, err.status, err.detail, err.extensions);
	}

	canonicalLog.set({
		error: err instanceof Error ? err.message : String(err),
	});
	return buildProblemResponse(c, 500, "Internal Server Error");
};

type ValidationError = { field: string; message: string };

export const zodProblemHook: Hook<
	unknown,
	Env,
	string,
	keyof ValidationTargets,
	object,
	$ZodType
> = (result) => {
	if (result.success) return;

	const errors: ValidationError[] = result.error.issues.map((issue) => ({
		field: issue.path.map(String).join("."),
		message: issue.message,
	}));

	throw new ProblemDetailsError(422, "Validation failed", { errors });
};
