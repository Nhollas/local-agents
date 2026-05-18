import { Data } from "effect";

export class WorkflowParseError extends Data.TaggedError("WorkflowParseError")<{
	message: string;
}> {}

export class WorkflowValidationError extends Data.TaggedError(
	"WorkflowValidationError",
)<{
	message: string;
}> {}

export class ShellExpansionError extends Data.TaggedError(
	"ShellExpansionError",
)<{
	message: string;
}> {}

/** @lintignore consumed in slice 6 (run-steps) */
export class AgentTurnError extends Data.TaggedError("AgentTurnError")<{
	message: string;
	subtype?: string;
}> {}

/** @lintignore consumed in slice 6 (run-steps) */
export class StructuredOutputDecodeError extends Data.TaggedError(
	"StructuredOutputDecodeError",
)<{
	message: string;
	context: "step" | "branch";
}> {}

export type WorkflowDefinitionError =
	| WorkflowParseError
	| WorkflowValidationError;
/** @lintignore consumed in slices 5/6 (engine entrypoints) */
export type WorkflowExecutionError =
	| ShellExpansionError
	| AgentTurnError
	| StructuredOutputDecodeError;
/** @lintignore consumed in slices 5/6 (engine entrypoints) */
export type WorkflowError = WorkflowDefinitionError | WorkflowExecutionError;
