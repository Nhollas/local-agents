import type { HttpClientRequest } from "@effect/platform";
import { Duration, Effect, Metric, MetricBoundaries } from "effect";

type HttpInstrument = <A, E, R>(
	endpoint: string,
	request: HttpClientRequest.HttpClientRequest,
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

export function makeHttpInstrument(options: {
	readonly service: string;
}): HttpInstrument {
	const service = options.service;
	return (endpoint, request, effect) =>
		effect.pipe(
			Metric.trackDurationWith(requestDuration, Duration.toMillis),
			Effect.tap(() => Metric.update(taggedTotal(service, endpoint, "ok"), 1)),
			Effect.tapErrorCause((cause) =>
				Effect.gen(function* () {
					yield* Metric.update(taggedTotal(service, endpoint, "error"), 1);
					yield* Effect.logError("http.request.failed", cause).pipe(
						Effect.annotateLogs({
							"peer.service": service,
							"http.endpoint": endpoint,
							"http.request.method": request.method,
							"url.full": request.url,
						}),
					);
				}),
			),
			Effect.withSpan(`${service}.${endpoint}`, {
				attributes: {
					"peer.service": service,
					"http.endpoint": endpoint,
					"http.request.method": request.method,
					"url.full": request.url,
				},
			}),
			Effect.annotateLogs({
				"peer.service": service,
				"http.endpoint": endpoint,
				"http.request.method": request.method,
			}),
		);
}

const requestDuration = Metric.histogram(
	"http.client.request.duration_ms",
	MetricBoundaries.exponential({ start: 10, factor: 2, count: 12 }),
	"Outbound HTTP request latency in milliseconds, tagged by peer.service and endpoint.",
);

const requestTotal = Metric.counter("http.client.requests_total", {
	description:
		"Outbound HTTP requests, tagged by peer.service, endpoint, and outcome.",
	incremental: true,
});

function taggedTotal(
	service: string,
	endpoint: string,
	outcome: "ok" | "error",
) {
	return requestTotal.pipe(
		Metric.tagged("peer.service", service),
		Metric.tagged("endpoint", endpoint),
		Metric.tagged("outcome", outcome),
	);
}
