import { Data } from "effect";

export class JiraHttpError extends Data.TaggedError("JiraHttpError")<{
	readonly message: string;
	readonly method: string;
	readonly url: string;
	readonly status?: number;
	readonly cause?: unknown;
}> {}

export class JiraParseError extends Data.TaggedError("JiraParseError")<{
	readonly message: string;
	readonly method: string;
	readonly url: string;
	readonly cause?: unknown;
}> {}

export class TrackerConfigError extends Data.TaggedError("TrackerConfigError")<{
	readonly message: string;
}> {}

export type TrackerError = JiraHttpError | JiraParseError;
