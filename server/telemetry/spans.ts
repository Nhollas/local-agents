import {
	type Attributes,
	type Span,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import type { IssueKey, RunId } from "../types/brands.ts";

export type { Span };

export const TRACER_NAME = "local-agents";
const tracer = trace.getTracer(TRACER_NAME);

type RunSpanContext = {
	runId: RunId;
	issueKey: IssueKey;
	issueTitle: string;
	issueUrl: string;
	repo: string;
};

export function runRunSpan<T>(
	ctx: RunSpanContext,
	fn: (traceId: string) => Promise<T>,
): Promise<T> {
	return withSpan(
		"run",
		{
			"run.id": ctx.runId,
			"issue.key": ctx.issueKey,
			"langfuse.trace.name": `${ctx.issueKey}: ${ctx.issueTitle}`,
			"langfuse.session.id": ctx.runId,
			"langfuse.trace.input": JSON.stringify({
				issueKey: ctx.issueKey,
				issueTitle: ctx.issueTitle,
				issueUrl: ctx.issueUrl,
				repo: ctx.repo,
			}),
			"langfuse.trace.tags": [ctx.repo, ctx.issueKey],
			"langfuse.trace.metadata.run_id": ctx.runId,
			"langfuse.trace.metadata.issue_key": ctx.issueKey,
			"langfuse.trace.metadata.repo": ctx.repo,
			"langfuse.trace.metadata.issue_url": ctx.issueUrl,
		},
		(traceId) => fn(traceId),
	);
}

export function runStepSpan<T>(
	stepName: string,
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(
		`step:${stepName}`,
		{
			attributes: {
				"workflow.step": stepName,
				"langfuse.observation.metadata.step_name": stepName,
			},
		},
		async (span) => {
			try {
				return await fn(span);
			} catch (err) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				throw err;
			} finally {
				span.end();
			}
		},
	);
}

function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (traceId: string) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, async (span) => {
		try {
			return await fn(span.spanContext().traceId);
		} catch (err) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: err instanceof Error ? err.message : String(err),
			});
			throw err;
		} finally {
			span.end();
		}
	});
}
