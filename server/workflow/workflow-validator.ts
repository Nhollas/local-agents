import type { RepoWorkflow, WorkflowStep } from "./workflow.ts";

export function validateOutputReferences(
	workflow: RepoWorkflow,
	sourcePath?: string,
): void {
	const stepsByName = new Map(
		workflow.steps.map((step) => [step.name, step] as const),
	);

	const allowedSteps = new Set<string>();
	for (const step of workflow.steps) {
		for (const reference of extractReferences(step.prompt)) {
			validateReference(reference, {
				sourcePath,
				location: `step "${step.name}".prompt`,
				stepsByName,
				allowedSteps,
			});
		}
		allowedSteps.add(step.name);
	}

	for (const field of ["title", "body"] as const) {
		for (const reference of extractReferences(workflow.change_request[field])) {
			validateReference(reference, {
				sourcePath,
				location: `change_request.${field}`,
				stepsByName,
				allowedSteps,
			});
		}
	}
}

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

function validateReference(
	reference: StepReference,
	ctx: ValidationContext,
): void {
	const { stepName, path } = reference;
	const step = ctx.stepsByName.get(stepName);
	if (!step) {
		fail(ctx, reference, `unknown step "${stepName}"`);
	}
	if (!ctx.allowedSteps.has(stepName)) {
		fail(ctx, reference, `forward reference to step "${stepName}"`);
	}
	if (path.length === 0) {
		fail(
			ctx,
			reference,
			"whole-output references are not supported — reference a specific field",
		);
	}
	if (!step.output_schema) {
		fail(
			ctx,
			reference,
			`step "${stepName}" has no output_schema — cannot resolve field "${path.join(".")}"`,
		);
	}

	walkSchemaPath(step.output_schema, path, reference, ctx, stepName);
}

function walkSchemaPath(
	schema: Record<string, unknown>,
	path: string[],
	reference: StepReference,
	ctx: ValidationContext,
	stepName: string,
): void {
	let current: Record<string, unknown> = schema;
	for (const key of path) {
		assertNoComposition(current, reference, ctx, stepName);
		const properties = current["properties"];
		if (!isRecord(properties) || !isRecord(properties[key])) {
			fail(
				ctx,
				reference,
				`unknown field "${key}" in step "${stepName}" output_schema`,
			);
		}
		current = properties[key] as Record<string, unknown>;
	}
	assertNoComposition(current, reference, ctx, stepName);
}

function assertNoComposition(
	schema: Record<string, unknown>,
	reference: StepReference,
	ctx: ValidationContext,
	stepName: string,
): void {
	for (const keyword of COMPOSITION_KEYWORDS) {
		if (keyword in schema) {
			fail(
				ctx,
				reference,
				`step "${stepName}" output_schema uses unsupported composition keyword "${keyword}" — validator does not support $ref/anyOf/oneOf/allOf`,
			);
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fail(
	ctx: ValidationContext,
	reference: StepReference,
	reason: string,
): never {
	const prefix = ctx.sourcePath ? `${ctx.sourcePath}: ` : "";
	throw new Error(
		`${prefix}${ctx.location}: invalid reference "{{ ${reference.raw} }}" — ${reason}`,
	);
}
