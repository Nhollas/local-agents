import { Data } from "effect";

export type { HttpClientError as TrackerError } from "../http/errors.ts";

export class TrackerConfigError extends Data.TaggedError("TrackerConfigError")<{
	readonly message: string;
}> {}
