import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { RepoWorkflow } from "./types.ts";
import { validateOutputReferences } from "./validator.ts";

const validate = (workflow: RepoWorkflow, sourcePath?: string) =>
	Effect.runSync(validateOutputReferences(workflow, sourcePath));

function workflow(overrides: Partial<RepoWorkflow> = {}): RepoWorkflow {
	return {
		branch: "agent/issue-{{ issue.number }}",
		steps: [
			{
				name: "implement",
				prompt: "Fix the issue",
				resume_previous: false,
				measure_diff: false,
				model: "claude-sonnet-4-6",
			},
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
		expect(() => validate(workflow())).not.toThrow();
	});

	it("rejects a step prompt referencing an unknown step", () => {
		const wf = workflow({
			steps: [
				{
					name: "implement",
					prompt: "Use {{ steps.missing.output.title }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf, "workflow.yaml")).toThrow(
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
				{
					name: "second",
					prompt: "Write a note",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { note: { type: "string" } },
					},
				},
			],
		});

		expect(() => validate(wf)).toThrow(
			/^first: invalid reference.*forward reference to step "second"/s,
		);
	});

	it("accepts a step prompt that references an earlier step's output", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write a summary",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).not.toThrow();
	});

	it("allows change_request to reference any step regardless of order", () => {
		const wf = workflow({
			steps: [
				{
					name: "implement",
					prompt: "Fix it",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
				{
					name: "summarise",
					prompt: "Summarise the fix",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
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

		expect(() => validate(wf)).not.toThrow();
	});

	it("rejects a change_request reference to an unknown step", () => {
		const wf = workflow({
			change_request: {
				title: "PR for {{ issue.key }}",
				body: "Refs {{ steps.missing.output.x }}",
			},
		});

		expect(() => validate(wf, "workflow.yaml")).toThrow(
			/workflow\.yaml.*change_request\.body.*unknown step "missing"/s,
		);
	});

	it("rejects a change_request.title typo against a real step's output_schema", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
			],
			change_request: {
				title: "PR: {{ steps.summarise.output.titel }}",
				body: "Body",
			},
		});

		expect(() => validate(wf, "workflow.yaml")).toThrow(
			/workflow\.yaml.*change_request\.title.*unknown field "titel".*step "summarise"/s,
		);
	});

	it("rejects a branch.agent.prompt reference to a step (none are visible in branch scope)", () => {
		const wf = workflow({
			branch: {
				prompt: "Pick a slug for {{ steps.summarise.output.title }}",
				schema: {
					type: "object",
					properties: { slug: { type: "string" } },
				},
				model: "claude-sonnet-4-6",
			},
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
			],
		});

		expect(() => validate(wf, "workflow.yaml")).toThrow(
			/workflow\.yaml.*branch\.agent\.prompt.*forward reference to step "summarise"/s,
		);
	});

	it("accepts a branch.agent.prompt with no step references", () => {
		const wf = workflow({
			branch: {
				prompt: "Pick a slug for {{ issue.key }}",
				schema: {
					type: "object",
					properties: { slug: { type: "string" } },
				},
				model: "claude-sonnet-4-6",
			},
		});

		expect(() => validate(wf)).not.toThrow();
	});

	it("rejects a reference to a top-level field not in the step's output_schema", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.missing }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).toThrow(
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).not.toThrow();
	});

	it("accepts a reference to a known nested field", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).not.toThrow();
	});

	it("rejects a reference to an unknown nested field", () => {
		const wf = workflow({
			steps: [
				{
					name: "summarise",
					prompt: "Write",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).toThrow(
			/unknown field "bogus".*step "summarise"/s,
		);
	});

	it("rejects a reference to a step without an output_schema", () => {
		const wf = workflow({
			steps: [
				{
					name: "plan",
					prompt: "Plan it",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
				{
					name: "implement",
					prompt: "Use {{ steps.plan.output.title }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).toThrow(
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: {
						type: "object",
						properties: { title: { type: "string" } },
					},
				},
				{
					name: "implement",
					prompt: "Whole: {{ steps.summarise.output }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).toThrow(
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
					measure_diff: false,
					model: "claude-sonnet-4-6",
					output_schema: { type: "object", ...fragment },
				},
				{
					name: "implement",
					prompt: "Use {{ steps.summarise.output.title }}",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
		});

		expect(() => validate(wf)).toThrow(
			`unsupported composition keyword "${keyword}"`,
		);
	});
});
