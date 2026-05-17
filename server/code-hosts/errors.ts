import { Data } from "effect";

export type { HttpClientError as CodeHostError } from "../http/errors.ts";

export class CodeHostConfigError extends Data.TaggedError(
	"CodeHostConfigError",
)<{
	readonly message: string;
}> {}
