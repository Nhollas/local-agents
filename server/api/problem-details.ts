import type { Hook } from "@hono/zod-validator";
import type { Context, Env, ErrorHandler, ValidationTargets } from "hono";
import { z } from "zod";
import type { $ZodType } from "zod/v4/core";
import * as canonicalLog from "../canonical-log.ts";

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
	c: Context,
	status: ProblemStatus,
	detail: string,
	extensions: Record<string, unknown> = {},
) {
	const body = {
		type: "about:blank",
		status,
		title: STATUS_TITLES[status],
		detail,
		...extensions,
	};

	return c.json(body, status);
}

export const problemDetailsHandler: ErrorHandler = (err, c) => {
	if (err instanceof ProblemDetailsError) {
		return buildProblemResponse(c, err.status, err.detail, err.extensions);
	}

	canonicalLog.set({
		error: canonicalLog.errorMessage(err),
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

	const flat = z.flattenError(result.error);
	const errors: ValidationError[] = Object.entries(flat.fieldErrors).flatMap(
		([field, messages]) =>
			(messages as string[]).map((message) => ({ field, message })),
	);

	throw new ProblemDetailsError(422, "Validation failed", { errors });
};
