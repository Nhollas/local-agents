import {
	HttpClient,
	type HttpClientRequest,
	HttpClientResponse,
} from "@effect/platform";
import { Duration, Effect, Schedule, type Schema } from "effect";
import { HttpParseError, HttpServiceError } from "./errors.ts";
import { makeHttpInstrument } from "./instrument.ts";

type ServiceHttpClient = {
	readonly execute: (
		endpoint: string,
		request: HttpClientRequest.HttpClientRequest,
	) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpServiceError>;
	readonly executeJson: <A, I>(
		endpoint: string,
		request: HttpClientRequest.HttpClientRequest,
		schema: Schema.Schema<A, I>,
	) => Effect.Effect<A, HttpServiceError | HttpParseError>;
};

type ServiceHttpClientOptions = {
	readonly service: string;
	readonly mapRequest?: (
		request: HttpClientRequest.HttpClientRequest,
	) => HttpClientRequest.HttpClientRequest;
};

export const makeServiceHttpClient = (
	options: ServiceHttpClientOptions,
): Effect.Effect<ServiceHttpClient, never, HttpClient.HttpClient> =>
	Effect.gen(function* () {
		const { service, mapRequest } = options;
		const instrument = makeHttpInstrument({ service });

		const defaultClient = yield* HttpClient.HttpClient;
		const client = defaultClient.pipe(
			mapRequest ? HttpClient.mapRequest(mapRequest) : (c) => c,
			HttpClient.filterStatusOk,
			HttpClient.retryTransient({
				times: MAX_ATTEMPTS - 1,
				schedule: Schedule.exponential(Duration.millis(BASE_DELAY_MS)),
			}),
		);

		const timeoutFail = (request: HttpClientRequest.HttpClientRequest) =>
			Effect.timeoutFail({
				duration: Duration.millis(TIMEOUT_MS),
				onTimeout: () =>
					new HttpServiceError({
						service,
						message: "request timed out",
						method: request.method,
						url: request.url,
					}),
			});

		const httpErrorTags = {
			ResponseError: (e: ResponseLike) =>
				Effect.fail(
					new HttpServiceError({
						service,
						message: e.message,
						method: e.request.method,
						url: e.request.url,
						status: e.response.status,
						cause: e,
					}),
				),
			RequestError: (e: RequestLike) =>
				Effect.fail(
					new HttpServiceError({
						service,
						message: e.message,
						method: e.request.method,
						url: e.request.url,
						cause: e,
					}),
				),
		};

		const execute: ServiceHttpClient["execute"] = (endpoint, request) =>
			instrument(
				endpoint,
				request,
				client
					.execute(request)
					.pipe(timeoutFail(request), Effect.catchTags(httpErrorTags)),
			);

		const executeJson: ServiceHttpClient["executeJson"] = (
			endpoint,
			request,
			schema,
		) =>
			instrument(
				endpoint,
				request,
				client.execute(request).pipe(
					timeoutFail(request),
					Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
					Effect.catchTags({
						...httpErrorTags,
						ParseError: (e) =>
							Effect.fail(
								new HttpParseError({
									service,
									message: e.message,
									method: request.method,
									url: request.url,
									cause: e,
								}),
							),
					}),
				),
			);

		return { execute, executeJson };
	});

type ResponseLike = {
	request: { method: string; url: string };
	response: { status: number };
	message: string;
};

type RequestLike = {
	request: { method: string; url: string };
	message: string;
};

const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1_000;
