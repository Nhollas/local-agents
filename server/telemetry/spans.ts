import { type Attributes, SpanStatusCode, trace } from "@opentelemetry/api";
import type { IssueKey, RunId } from "../types/brands.ts";

const tracer = trace.getTracer("local-agents");

export function runRunSpan<T>(
	runId: RunId,
	issueKey: IssueKey,
	fn: (traceId: string) => Promise<T>,
): Promise<T> {
	return withSpan(
		"run",
		{ "run.id": runId, "issue.key": issueKey },
		(traceId) => fn(traceId),
	);
}

export function runStepSpan<T>(
	stepName: string,
	fn: () => Promise<T>,
): Promise<T> {
	return withSpan(`step:${stepName}`, { "workflow.step": stepName }, () =>
		fn(),
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
