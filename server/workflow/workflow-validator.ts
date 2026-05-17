import { Effect } from "effect";
import { WorkflowValidationError } from "./errors.ts";
import type { RepoWorkflow, WorkflowStep } from "./workflow.ts";

export const validateOutputReferences = (
	workflow: RepoWorkflow,
	sourcePath?: string,
): Effect.Effect<void, WorkflowValidationError> =>
	Effect.gen(function* () {
		const stepsByName = new Map(
			workflow.steps.map((step) => [step.name, step] as const),
		);

		const allowedSteps = new Set<string>();
		for (const step of workflow.steps) {
			for (const reference of extractReferences(step.prompt)) {
				yield* validateReference(reference, {
					sourcePath,
					location: `step "${step.name}".prompt`,
					stepsByName,
					allowedSteps,
				});
			}
			allowedSteps.add(step.name);
		}

		for (const field of ["title", "body"] as const) {
			for (const reference of extractReferences(
				workflow.change_request[field],
			)) {
				yield* validateReference(reference, {
					sourcePath,
					location: `change_request.${field}`,
					stepsByName,
					allowedSteps,
				});
			}
		}
	});

const STEPS_REFERENCE_RE =
	/\{\{\s*steps\.(?<stepName>\w+)\.output(?<rest>(?:\.\w+)*)\s*\}\}/g;

const COMPOSITION_KEYWORDS = ["$ref", "anyOf", "oneOf", "allOf"] as const;

type StepReference = {
	raw: string;
	stepName: string;
	path: string[];
};

type ValidationContext = {
	sourcePath: string | undefined;
	location: string;
	stepsByName: Map<string, WorkflowStep>;
	allowedSteps: Set<string>;
};

function extractReferences(template: string): StepReference[] {
	const references: StepReference[] = [];
	for (const match of template.matchAll(STEPS_REFERENCE_RE)) {
		const groups = match.groups as { stepName: string; rest: string };
		const path = groups.rest === "" ? [] : groups.rest.slice(1).split(".");
		references.push({
			raw: `steps.${groups.stepName}.output${groups.rest}`,
			stepName: groups.stepName,
			path,
		});
	}
	return references;
}

const validateReference = (
	reference: StepReference,
	ctx: ValidationContext,
): Effect.Effect<void, WorkflowValidationError> =>
	Effect.gen(function* () {
		const { stepName, path } = reference;
		const step = ctx.stepsByName.get(stepName);
		if (!step) {
			return yield* fail(ctx, reference, `unknown step "${stepName}"`);
		}
		if (!ctx.allowedSteps.has(stepName)) {
			return yield* fail(
				ctx,
				reference,
				`forward reference to step "${stepName}"`,
			);
		}
		if (path.length === 0) {
			return yield* fail(
				ctx,
				reference,
				"whole-output references are not supported — reference a specific field",
			);
		}
		if (!step.output_schema) {
			return yield* fail(
				ctx,
				reference,
				`step "${stepName}" has no output_schema — cannot resolve field "${path.join(".")}"`,
			);
		}

		yield* walkSchemaPath(step.output_schema, path, reference, ctx, stepName);
	});

const walkSchemaPath = (
	schema: Record<string, unknown>,
	path: string[],
	reference: StepReference,
	ctx: ValidationContext,
	stepName: string,
): Effect.Effect<void, WorkflowValidationError> =>
	Effect.gen(function* () {
		let current: Record<string, unknown> = schema;
		for (const key of path) {
			yield* assertNoComposition(current, reference, ctx, stepName);
			const properties = current["properties"];
			const next = isRecord(properties) ? properties[key] : undefined;
			if (!isRecord(next)) {
				return yield* fail(
					ctx,
					reference,
					`unknown field "${key}" in step "${stepName}" output_schema`,
				);
			}
			current = next;
		}
		yield* assertNoComposition(current, reference, ctx, stepName);
	});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const assertNoComposition = (
	schema: Record<string, unknown>,
	reference: StepReference,
	ctx: ValidationContext,
	stepName: string,
): Effect.Effect<void, WorkflowValidationError> =>
	Effect.gen(function* () {
		for (const keyword of COMPOSITION_KEYWORDS) {
			if (keyword in schema) {
				return yield* fail(
					ctx,
					reference,
					`step "${stepName}" output_schema uses unsupported composition keyword "${keyword}" — validator does not support $ref/anyOf/oneOf/allOf`,
				);
			}
		}
	});

const fail = (
	ctx: ValidationContext,
	reference: StepReference,
	reason: string,
): Effect.Effect<never, WorkflowValidationError> => {
	const prefix = ctx.sourcePath ? `${ctx.sourcePath}: ` : "";
	return Effect.fail(
		new WorkflowValidationError({
			message: `${prefix}${ctx.location}: invalid reference "{{ ${reference.raw} }}" — ${reason}`,
		}),
	);
};
