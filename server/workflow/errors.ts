import { Data } from "effect";
import type { StepUsage } from "./types.ts";

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

export class AgentTurnError extends Data.TaggedError("AgentTurnError")<{
	message: string;
	subtype?: string;
	usage?: StepUsage;
	sessionId?: string;
}> {}

export class StructuredOutputDecodeError extends Data.TaggedError(
	"StructuredOutputDecodeError",
)<{
	message: string;
	context: "step" | "branch";
}> {}

export type WorkflowDefinitionError =
	| WorkflowParseError
	| WorkflowValidationError;
export type WorkflowExecutionError =
	| ShellExpansionError
	| AgentTurnError
	| StructuredOutputDecodeError;
