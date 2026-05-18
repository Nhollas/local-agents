import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { FinalizeFailurePhase } from "../db/schema.ts";
import type { Last24hStats } from "../db/stats-query.ts";
import { eventBus } from "../event-bus.ts";
import type { RunEvent } from "../event-schema.ts";
import type { Orchestrator } from "../orchestrator/orchestrator.ts";
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
import {
	ProblemDetailsError,
	problemDetailsHandler,
	zodProblemHook,
} from "./problem-details.ts";
import { requestIdMiddleware } from "./request-id-middleware.ts";
import type { AppEnv } from "./types.ts";

type HealthCheckResult = {
	status: "healthy" | "unhealthy";
	checks: Record<string, { status: "pass" | "fail"; message?: string }>;
};

export type HealthCheck = () => HealthCheckResult;

export function createApi({
	runner,
	repo,
	queue,
	readStats,
	checkHealth,
	clock = () => new Date(),
}: {
	runner: Runner;
	repo: RunRepository;
	queue: Pick<Orchestrator, "getQueueSnapshot">;
	readStats: (now: Date) => Last24hStats;
	checkHealth: HealthCheck;
	clock?: () => Date;
}) {
	const app = new Hono<AppEnv>();
	app.onError(problemDetailsHandler);

	app.get("/events", (c) => {
		return streamSSE(c, async (stream) => {
			const lastEventId =
				c.req.header("Last-Event-ID") ??
				c.req.query("lastEventId") ??
				undefined;
			const sinceSeq =
				lastEventId != null ? (repo.getEventSeqById(lastEventId) ?? 0) : 0;

			const buffered: RunEvent[] = [];
			let live = false;
			const handler = (event: RunEvent) => {
				if (live) {
					void writeFrame(stream, event);
				} else {
					buffered.push(event);
				}
			};

			eventBus.on(handler);

			stream.onAbort(() => {
				eventBus.off(handler);
			});

			let replayedSeq = sinceSeq;
			for (const event of repo.getAllEventsAfterSeq(sinceSeq)) {
				await writeFrame(stream, event);
				replayedSeq = event.seq;
			}
			// Drain anything that arrived during replay.
			for (const event of buffered.splice(0)) {
				if (event.seq > replayedSeq) await writeFrame(stream, event);
			}
			live = true;

			while (true) {
				await stream.writeSSE({ event: "heartbeat", data: "" });
				await stream.sleep(30_000);
			}
		});
	});

	app.use(requestIdMiddleware);

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

	app.get(
		"/runs/:id/events",
		zValidator("param", runParamSchema, zodProblemHook),
		zValidator("query", runEventsQuerySchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");
			const { since } = c.req.valid("query");

			const run = repo.getRunById(id);
			if (!run) throw new ProblemDetailsError(404, "Not found");

			if (since != null) {
				const sinceSeq = repo.getEventSeqById(since);
				if (sinceSeq == null) {
					throw new ProblemDetailsError(400, "Unknown since cursor");
				}
				return c.json(repo.getRunEventsAfterSeq(id, sinceSeq));
			}
			return c.json(repo.getRunEvents(id));
		},
	);

	app.post(
		"/runs/:id/kill",
		zValidator("param", runParamSchema, zodProblemHook),
		(c) => {
			const { id } = c.req.valid("param");
			const run = repo.getRunById(id);
			if (!run) throw new ProblemDetailsError(404, "Not found");
			if (run.status !== "running") {
				throw new ProblemDetailsError(409, `Run already ${run.status}`);
			}
			const killed = runner.kill(id);
			return c.json({ killed });
		},
	);

	app.get("/stats", (c) => {
		const now = clock();
		const stats: StatsWire = {
			asOf: now.toISOString(),
			running: {
				active: repo.countRunning(),
				max: runner.maxConcurrency,
			},
			queued: { count: queue.getQueueSnapshot().length },
			last24h: readStats(now),
		};
		return c.json(stats);
	});

	app.get("/queue", (c) => {
		const active: ActiveRunWire[] = repo
			.getRuns({ status: "running", limit: 200 })
			.map((run) => {
				const steps = repo.getRunSteps(run.id);
				return {
					...runToWire(run),
					currentStep: currentStepFor(steps),
					progressRatio: progressRatioFor(steps),
				};
			});
		return c.json({ active, queued: queue.getQueueSnapshot() });
	});

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

const runEventsQuerySchema = z.object({
	since: z.string().min(1).optional(),
});

type RunWire = {
	id: string;
	status: Run["status"];
	repo: string;
	repoUrl: string | null;
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
	failedStep: { index: number; name: string } | null;
	finalizeFailure: { phase: FinalizeFailurePhase; error: string } | null;
	langfuseTraceUrl: string | null;
};

type StepWire = Omit<RunStepRow, "runId">;

type CurrentStepWire = { name: string; index: number; total: number };

type ActiveRunWire = RunWire & {
	currentStep: CurrentStepWire | null;
	progressRatio: number;
};

type StatsWire = {
	asOf: string;
	running: { active: number; max: number };
	queued: { count: number };
	last24h: Last24hStats;
};

function currentStepFor(steps: RunStepRow[]): CurrentStepWire | null {
	const running = steps.find((s) => s.state === "running");
	if (!running) return null;
	return { name: running.name, index: running.index, total: steps.length };
}

function progressRatioFor(steps: RunStepRow[]): number {
	if (steps.length === 0) return 0;
	const completed = steps.filter((s) => s.state === "completed").length;
	const inFlight = steps.some((s) => s.state === "running") ? 0.5 : 0;
	return (completed + inFlight) / steps.length;
}

async function writeFrame(
	stream: {
		writeSSE: (frame: {
			id?: string;
			event: string;
			data: string;
		}) => Promise<void>;
	},
	event: RunEvent,
): Promise<void> {
	try {
		await stream.writeSSE({
			id: event.id,
			event: event.kind,
			data: JSON.stringify(event),
		});
	} catch {
		// stream aborted; cleanup runs via onAbort
	}
}

function runToWire(run: Run): RunWire {
	const base: RunWire = {
		id: run.id,
		status: run.status,
		repo: run.repo,
		repoUrl: run.repoUrl,
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
		completedAt: null,
		durationMs: null,
		error: null,
		failedStep: null,
		finalizeFailure: null,
		langfuseTraceUrl: run.langfuseTraceUrl,
	};
	switch (run.status) {
		case "running":
			return base;
		case "completed":
			return {
				...base,
				completedAt: run.completedAt,
				durationMs: run.durationMs,
			};
		case "failed":
			return {
				...base,
				completedAt: run.completedAt,
				durationMs: run.durationMs,
				error: run.error,
				failedStep: run.failedStep,
				finalizeFailure: run.finalizeFailure,
			};
	}
}

function stepToWire({ runId: _runId, ...rest }: RunStepRow): StepWire {
	return rest;
}
