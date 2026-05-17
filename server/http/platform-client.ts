import {
	HttpClient,
	HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import {
	Duration,
	Effect,
	Metric,
	MetricBoundaries,
	Schedule,
	type Schema,
} from "effect";
import {
	type HttpClientError,
	HttpParseError,
	HttpServiceError,
} from "./errors.ts";

export const platformHttpClient = (options: {
	readonly service: string;
	readonly baseUrl?: string;
	readonly mapRequest?: (
		req: HttpClientRequest.HttpClientRequest,
	) => HttpClientRequest.HttpClientRequest;
}) =>
	Effect.gen(function* () {
		const base = yield* HttpClient.HttpClient;
		const { service, baseUrl, mapRequest } = options;
		const http = base.pipe(
			baseUrl
				? HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl))
				: (c) => c,
			HttpClient.mapRequest(mapRequest ?? ((req) => req)),
			HttpClient.filterStatusOk,
			HttpClient.retryTransient({
				times: 2,
				schedule: Schedule.exponential(Duration.millis(1_000)),
			}),
			HttpClient.transform((effect, request) =>
				effect.pipe(
					Effect.timeoutFail({
						duration: Duration.millis(30_000),
						onTimeout: () =>
							new HttpServiceError({
								message: "request timed out",
								method: request.method,
								url: request.url,
							}),
					}),
				),
			),
			HttpClient.catchTags({
				ResponseError: (e) =>
					Effect.fail(
						new HttpServiceError({
							message: e.message,
							method: e.request.method,
							url: e.request.url,
							status: e.response.status,
							cause: e,
						}),
					),
				RequestError: (e) =>
					Effect.fail(
						new HttpServiceError({
							message: e.message,
							method: e.request.method,
							url: e.request.url,
							cause: e,
						}),
					),
			}),
		);

		const taggedTotal = (endpoint: string, outcome: "ok" | "error") =>
			requestTotal.pipe(
				Metric.tagged("peer.service", service),
				Metric.tagged("endpoint", endpoint),
				Metric.tagged("outcome", outcome),
			);

		const instrument =
			(name: string, attributes: Record<string, string>) =>
			<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
				effect.pipe(
					Metric.trackDurationWith(requestDuration, Duration.toMillis),
					Effect.tap(() => Metric.update(taggedTotal(name, "ok"), 1)),
					Effect.tapErrorCause(() =>
						Metric.update(taggedTotal(name, "error"), 1),
					),
					Effect.withSpan(`${service}.${name}`, {
						attributes: {
							"peer.service": service,
							"http.endpoint": name,
							...attributes,
						},
					}),
				);

		return { http, instrument };
	});

export const parseResponseBody =
	<A, I>(schema: Schema.Schema<A, I>) =>
	<E>(
		response: Effect.Effect<HttpClientResponse.HttpClientResponse, E>,
	): Effect.Effect<A, E | HttpClientError> =>
		response.pipe(
			Effect.flatMap((res) =>
				HttpClientResponse.schemaBodyJson(schema)(res).pipe(
					Effect.catchTags({
						ParseError: (e) =>
							Effect.fail(
								new HttpParseError({
									message: e.message,
									method: res.request.method,
									url: res.request.url,
									cause: e,
								}),
							),
						ResponseError: (e) =>
							Effect.fail(
								new HttpServiceError({
									message: e.message,
									method: e.request.method,
									url: e.request.url,
									status: e.response.status,
									cause: e,
								}),
							),
					}),
				),
			),
		);

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
