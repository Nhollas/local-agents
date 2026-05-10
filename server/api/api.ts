import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { eventBus, type RunEvent } from "../event-bus.ts";
import type { Logger } from "../logger.ts";
import type {
	Run,
	RunRepository,
	RunStep as RunStepRow,
} from "../run-repository.ts";
import type { Runner } from "../runner/runner.ts";
import {
	repoSlug as brandRepoSlug,
	runId as brandRunId,
} from "../types/brands.ts";
import { createCanonicalLogMiddleware } from "./canonical-log-middleware.ts";
import {
	ProblemDetailsError,
	problemDetailsHandler,
	zodProblemHook,
} from "./problem-details.ts";
import type { AppEnv } from "./types.ts";

type HealthCheckResult = {
	status: "healthy" | "unhealthy";
	checks: Record<string, { status: "pass" | "fail"; message?: string }>;
};

export type HealthCheck = () => HealthCheckResult;

export function createApi({
	runner,
	repo,
	checkHealth,
	logger,
}: {
	runner: Runner;
	repo: RunRepository;
	checkHealth: HealthCheck;
	logger: Logger;
}) {
	const app = new Hono<AppEnv>();
	app.onError(problemDetailsHandler);

	app.get("/events", (c) => {
		return streamSSE(c, async (stream) => {
			const handler = async (event: RunEvent) => {
				try {
					await stream.writeSSE({
						event: event.type,
						data: JSON.stringify(event),
					});
				} catch {
					// stream aborted; cleanup runs via onAbort
				}
			};

			eventBus.on(handler);

			stream.onAbort(() => {
				eventBus.off(handler);
			});

			while (true) {
				await stream.writeSSE({ event: "heartbeat", data: "" });
				await stream.sleep(30_000);
			}
		});
	});

	app.use(createCanonicalLogMiddleware(logger));

	app.get(
		"/runs",
		zValidator("query", runsQuerySchema, zodProblemHook),
		(c) => {
			const { status, repo: repoFilter, limit } = c.req.valid("query");
			return c.json(
				repo
					.getRuns({ status, repo: repoFilter || undefined, limit })
					.map(runToWire),
			);
		},
	);

	app.get(
		"/runs/:id",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");

			const run = repo.getRunById(id);
			if (!run) throw new ProblemDetailsError(404, "Not found");

			const steps = repo.getRunSteps(id).map(stepToWire);
			return c.json({ run: runToWire(run), steps });
		},
	);

	app.post(
		"/runs/:id/kill",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");
			const killed = runner.kill(id);
			if (!killed)
				throw new ProblemDetailsError(404, "Run not found or not running");
			return c.json({ killed: true });
		},
	);

	app.get("/health", (c) => {
		const result = checkHealth();
		return c.json(result, result.status === "healthy" ? 200 : 503);
	});

	return app;
}

const runsQuerySchema = z.object({
	status: z.enum(["running", "completed", "failed"]).optional(),
	repo: z
		.string()
		.min(1)
		.optional()
		.transform((v) => v && brandRepoSlug(v)),
	limit: z.coerce.number().int().min(1).max(200).optional().default(50),
});

const runParamSchema = z.object({
	id: z.string().min(1).transform(brandRunId),
});

type RunWire = {
	id: string;
	status: Run["status"];
	repo: string;
	branch: string | null;
	workspaceDir: string | null;
	issueKey: string | null;
	issueTitle: string | null;
	issueUrl: string | null;
	startedAt: string;
	completedAt: string | null;
	durationMs: number | null;
	costUsd: number | null;
	tokensInput: number | null;
	tokensOutput: number | null;
	pr: Run["pr"];
	error: string | null;
};

type StepWire = Omit<RunStepRow, "runId">;

function runToWire(run: Run): RunWire {
	const base: Omit<RunWire, "completedAt" | "durationMs" | "error"> = {
		id: run.id,
		status: run.status,
		repo: run.repo,
		branch: run.branch,
		workspaceDir: run.workspaceDir,
		issueKey: run.issueKey,
		issueTitle: run.issueTitle,
		issueUrl: run.issueUrl,
		startedAt: run.startedAt,
		costUsd: run.costUsd,
		tokensInput: run.tokensInput,
		tokensOutput: run.tokensOutput,
		pr: run.pr,
	};
	switch (run.status) {
		case "running":
			return { ...base, completedAt: null, durationMs: null, error: null };
		case "completed":
			return {
				...base,
				completedAt: run.completedAt,
				durationMs: run.durationMs,
				error: null,
			};
		case "failed":
			return {
				...base,
				completedAt: run.completedAt,
				durationMs: run.durationMs,
				error: run.error,
			};
	}
}

function stepToWire({ runId: _runId, ...rest }: RunStepRow): StepWire {
	return rest;
}
