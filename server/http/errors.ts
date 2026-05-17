import { Data } from "effect";

export class HttpServiceError extends Data.TaggedError("HttpServiceError")<{
	readonly service: string;
	readonly message: string;
	readonly method: string;
	readonly url: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class HttpParseError extends Data.TaggedError("HttpParseError")<{
	readonly service: string;
	readonly message: string;
	readonly method: string;
	readonly url: string;
	readonly cause?: unknown;
}> {}

export type HttpClientError = HttpServiceError | HttpParseError;
