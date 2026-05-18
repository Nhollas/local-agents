import { Data } from "effect";
import type { HttpClientError } from "../http/errors.ts";

export class JiraTransitionNotFoundError extends Data.TaggedError(
	"JiraTransitionNotFoundError",
)<{
	readonly issueKey: string;
	readonly targetStatus: string;
}> {}

export type TrackerError = HttpClientError | JiraTransitionNotFoundError;
