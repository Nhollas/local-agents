import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { IssueKey, RunId } from "../types/brands.ts";

const tracer = trace.getTracer("local-agents");

export function runRunSpan<T>(
	runId: RunId,
	issueKey: IssueKey,
	fn: (traceId: string) => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(
		"run",
		{ attributes: { "run.id": runId, "issue.key": issueKey } },
		async (span) => {
			const traceId = span.spanContext().traceId;
			try {
				const result = await fn(traceId);
				span.end();
				return result;
			} catch (err) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				span.end();
				throw err;
			}
		},
	);
}

export function runStepSpan<T>(
	stepName: string,
	fn: () => Promise<T>,
): Promise<T> {
	return tracer.startActiveSpan(
		`step:${stepName}`,
		{ attributes: { "workflow.step": stepName } },
		async (span) => {
			try {
				const result = await fn();
				span.end();
				return result;
			} catch (err) {
				span.setStatus({
					code: SpanStatusCode.ERROR,
					message: err instanceof Error ? err.message : String(err),
				});
				span.end();
				throw err;
			}
		},
	);
}
