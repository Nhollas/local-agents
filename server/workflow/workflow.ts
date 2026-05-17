import { Effect, ParseResult, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import type { Issue } from "../trackers/types.ts";
import { ModelIdSchema } from "../types/model-id.ts";
import { WorkflowParseError } from "./errors.ts";
import { stripShellBlockMarkers } from "./prompt-preprocessor.ts";

const JsonSchemaDocument = Schema.Record({
	key: Schema.String,
	value: Schema.Unknown,
});

const WorkflowStepSchema = Schema.Struct({
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

export type WorkflowStep = typeof WorkflowStepSchema.Type;

const ChangeRequestSchema = Schema.Struct({
	title: Schema.String.pipe(Schema.minLength(1)),
	body: Schema.String.pipe(Schema.minLength(1)),
});

export type ChangeRequestTemplate = typeof ChangeRequestSchema.Type;

const BranchAgentSchema = Schema.Struct({
	prompt: Schema.String.pipe(Schema.minLength(1)),
	schema: JsonSchemaDocument,
	model: ModelIdSchema,
});

const BranchSchema = Schema.Union(
	Schema.String.pipe(Schema.minLength(1)),
	BranchAgentSchema,
);

export type WorkflowBranch = typeof BranchSchema.Type;

const RepoWorkflowSchema = Schema.Struct({
	branch: BranchSchema,
	steps: Schema.Array(WorkflowStepSchema).pipe(Schema.minItems(1)),
	change_request: ChangeRequestSchema,
});

export type RepoWorkflow = typeof RepoWorkflowSchema.Type;

const decodeRepoWorkflow = Schema.decodeUnknown(RepoWorkflowSchema, {
	onExcessProperty: "error",
});

export const parseRepoWorkflow = (
	yamlContent: string,
): Effect.Effect<RepoWorkflow, WorkflowParseError> =>
	Effect.gen(function* () {
		const raw = yield* Effect.try({
			try: () => parseYaml(yamlContent),
			catch: (err) =>
				new WorkflowParseError({
					message: err instanceof Error ? err.message : String(err),
				}),
		});
		return yield* decodeRepoWorkflow(raw).pipe(
			Effect.mapError(
				(err) =>
					new WorkflowParseError({
						message: ParseResult.TreeFormatter.formatErrorSync(err),
					}),
			),
		);
	});

export function renderPrompt(
	template: string,
	vars: {
		issue: Issue;
		branch?: string;
		base_branch?: string;
		outputs?: Record<string, unknown> | undefined;
	},
): string {
	const root: Record<string, unknown> = {
		issue: vars.issue,
		branch: vars.branch,
		base_branch: vars.base_branch,
		steps: Object.fromEntries(
			Object.entries(vars.outputs ?? {}).map(([name, output]) => [
				name,
				{ output },
			]),
		),
	};
	return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path: string) => {
		let value: unknown = root;
		for (const part of path.split(".")) {
			if (!isRecord(value)) return "";
			value = value[part];
		}
		if (value == null) return "";
		const rendered = Array.isArray(value)
			? value.map((item) => String(item)).join(", ")
			: typeof value === "object"
				? JSON.stringify(value)
				: String(value);
		return stripShellBlockMarkers(rendered);
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}
