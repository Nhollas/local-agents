import { describe, expect, it } from "vitest";
import type { RepoWorkflow } from "./workflow.ts";
import { validateOutputReferences } from "./workflow-validator.ts";

function workflow(overrides: Partial<RepoWorkflow> = {}): RepoWorkflow {
	return {
		branch: "agent/issue-{{ issue.number }}",
		steps: [
			{ name: "implement", prompt: "Fix the issue", resume_previous: false },
		],
		change_request: {
			title: "PR for {{ issue.key }}",
			body: "Closes {{ issue.key }}",
		},
		...overrides,
	};
}

describe("validateOutputReferences", () => {
	it("accepts a workflow with no step output references", () => {
		expect(() => validateOutputReferences(workflow())).not.toThrow();
	});

	it("rejects a step prompt referencing an unknown step", () => {
		const wf = workflow({
			steps: [
				{
					name: "implement",
					prompt: "Use {{ steps.missing.output.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf, "workflow.yaml")).toThrow(
			/workflow\.yaml.*steps\.missing\.output\.title.*unknown step "missing"/s,
		);
	});

	it("rejects a step prompt that forward-references a later step", () => {
		const wf = workflow({
			steps: [
				{
					name: "first",
					prompt: "Read {{ steps.second.output.note }}",
					resume_previous: false,
				},
				{
					name: "second",
					prompt: "Write a note",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { note: { type: "string" } },
					},
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			/step "first"\.prompt.*forward reference to step "second"/s,
		);
	});

	it("accepts a step prompt that references an earlier step's output", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write a summary",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).not.toThrow();
	});

	it("allows change_request to reference any step regardless of order", () => {
		const wf = workflow({
			steps: [
				{
					name: "implement",
					prompt: "Fix it",
					resume_previous: false,
				},
				{
					name: "summarise",
					prompt: "Summarise the fix",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
			],
			change_request: {
				title: "PR: {{ steps.summarise.output.title }}",
				body: "Done — {{ steps.summarise.output.title }}",
			},
		});

		expect(() => validateOutputReferences(wf)).not.toThrow();
	});

	it("rejects a change_request reference to an unknown step", () => {
		const wf = workflow({
			change_request: {
				title: "PR for {{ issue.key }}",
				body: "Refs {{ steps.missing.output.x }}",
			},
		});

		expect(() => validateOutputReferences(wf, "workflow.yaml")).toThrow(
			/workflow\.yaml.*change_request\.body.*unknown step "missing"/s,
		);
	});

	it("rejects a reference to a top-level field not in the step's output_schema", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.missing }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			/unknown field "missing".*step "summarise"/s,
		);
	});

	it("accepts a reference to a known top-level field", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).not.toThrow();
	});

	it("accepts a reference to a known nested field", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: {
							summary: {
								type: "object",
								properties: { title: { type: "string" } },
							},
						},
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.summary.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).not.toThrow();
	});

	it("rejects a reference to an unknown nested field", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: {
							summary: {
								type: "object",
								properties: { title: { type: "string" } },
							},
						},
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.summary.bogus }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			/unknown field "bogus".*step "summarise"/s,
		);
	});

	it("rejects a reference to a step without an output_schema", () => {
		const wf = workflow({
			steps: [
				{ name: "plan", prompt: "Plan it", resume_previous: false },
				{
					name: "implement",
					prompt: "Use {{ steps.plan.output.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			/step "plan" has no output_schema.*cannot resolve field "title"/s,
		);
	});

	it("rejects a whole-output reference because the renderer can't resolve it", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Whole: {{ steps.summarise.output }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			/whole-output references are not supported/,
		);
	});

	it.each([
		["$ref", { $ref: "#/$defs/X" }],
		["anyOf", { anyOf: [{ type: "string" }] }],
		["oneOf", { oneOf: [{ type: "string" }] }],
		["allOf", { allOf: [{ type: "object" }] }],
	] as const)("rejects a referenced output_schema using %s composition", (keyword, fragment) => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					output_schema: { type: "object", ...fragment },
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
				},
			],
		});

		expect(() => validateOutputReferences(wf)).toThrow(
			`unsupported composition keyword "${keyword}"`,
		);
	});
});
