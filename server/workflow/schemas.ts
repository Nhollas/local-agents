import { Schema } from "effect";
import { ModelIdSchema } from "./model-id.ts";

const JsonSchemaDocument = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
});

export const WorkflowStepSchema = Schema.Struct({
	name: Schema.String.pipe(
		Schema.pattern(/^\w+$/, {
			message: () =>
				"step name must contain only letters, digits, and underscores",
		}),
	),
	prompt: Schema.String,
	resume_previous: Schema.optionalWith(Schema.Boolean, {
		exact: true,
		default: () => false,
	}),
	output_schema: Schema.optional(JsonSchemaDocument),
	model: ModelIdSchema,
	allowed_tools: Schema.optional(
		Schema.Array(Schema.String.pipe(Schema.minLength(1))).pipe(
			Schema.minItems(1),
		),
	),
	measure_diff: Schema.optionalWith(Schema.Boolean, {
		exact: true,
		default: () => false,
	}),
});

export const ChangeRequestSchema = Schema.Struct({
	title: Schema.String.pipe(Schema.minLength(1)),
	body: Schema.String.pipe(Schema.minLength(1)),
});

const BranchAgentSchema = Schema.Struct({
	prompt: Schema.String.pipe(Schema.minLength(1)),
	schema: JsonSchemaDocument,
	model: ModelIdSchema,
});

export const BranchSchema = Schema.Union(
	Schema.String.pipe(Schema.minLength(1)),
	BranchAgentSchema,
);

export const RepoWorkflowSchema = Schema.Struct({
	branch: BranchSchema,
	steps: Schema.Array(WorkflowStepSchema).pipe(Schema.minItems(1)),
	change_request: ChangeRequestSchema,
});
