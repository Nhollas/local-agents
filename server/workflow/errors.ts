import { Data } from "effect";

export class WorkflowParseError extends Data.TaggedError("WorkflowParseError")<{
	readonly message: string;
}> {}

export class WorkflowValidationError extends Data.TaggedError(
	"WorkflowValidationError",
)<{
	readonly message: string;
}> {}

export class ShellExpansionError extends Data.TaggedError(
	"ShellExpansionError",
)<{
	readonly message: string;
}> {}
