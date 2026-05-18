import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { parseRepoWorkflow } from "./parse.ts";

const parse = (yaml: string) => Effect.runSync(parseRepoWorkflow(yaml));

const validChangeRequest = `
change_request:
  title: "PR for {{ issue.key }}"
  body: "Closes {{ issue.key }}"
`;

describe("parseRepoWorkflow", () => {
	it("accepts a single-step workflow", () => {
		const yaml = `
branch: "agent/issue-{{ issue.number }}"
steps:
  - name: implement
    prompt: Fix this issue
    model: claude-sonnet-4-6
${validChangeRequest}`;

		const result = parse(yaml);

		expect(result).toEqual({
			branch: "agent/issue-{{ issue.number }}",
			steps: [
				{
					name: "implement",
					prompt: "Fix this issue",
					resume_previous: false,
					measure_diff: false,
					model: "claude-sonnet-4-6",
				},
			],
			change_request: {
				title: "PR for {{ issue.key }}",
				body: "Closes {{ issue.key }}",
			},
		});
	});

	it("accepts a multi-step workflow with resume_previous", () => {
		const yaml = `
branch: "agent/issue-{{ issue.number }}"
steps:
  - name: plan
    prompt: Write a plan
    model: claude-sonnet-4-6
  - name: implement
    prompt: Implement the plan
    resume_previous: true
    model: claude-sonnet-4-6
${validChangeRequest}`;

		const result = parse(yaml);

		expect(result.steps).toEqual([
			{
				name: "plan",
				prompt: "Write a plan",
				resume_previous: false,
				measure_diff: false,
				model: "claude-sonnet-4-6",
			},
			{
				name: "implement",
				prompt: "Implement the plan",
				resume_previous: true,
				measure_diff: false,
				model: "claude-sonnet-4-6",
			},
		]);
	});

	it("rejects workflows missing change_request", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects change_request missing title", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
change_request:
  body: "Closes {{ issue.key }}"
`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects change_request missing body", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
change_request:
  title: "PR"
`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects change_request with unknown keys", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
change_request:
  title: "PR"
  body: "Closes"
  labels: [bug]
`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects workflows missing branch", () => {
		const yaml = "steps:\n  - name: x\n    prompt: Fix it\n";

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects workflows missing steps", () => {
		const yaml = "branch: my-branch\n";

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects workflows with an empty steps array", () => {
		const yaml = "branch: my-branch\nsteps: []\n";

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects unknown step keys", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
    bogus: value
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("accepts a dynamic branch agent block", () => {
		const yaml = `
branch:
  prompt: "Propose a name for {{ issue.key }}"
  model: claude-haiku-4-5
  schema:
    type: object
    properties:
      name:
        type: string
        pattern: "^feat/"
    required: [name]
steps:
  - name: implement
    prompt: Fix it
    model: claude-sonnet-4-6
${validChangeRequest}`;

		const result = parse(yaml);

		expect(result.branch).toEqual({
			prompt: "Propose a name for {{ issue.key }}",
			model: "claude-haiku-4-5",
			schema: {
				type: "object",
				properties: { name: { type: "string", pattern: "^feat/" } },
				required: ["name"],
			},
		});
	});

	it("rejects a branch object missing prompt", () => {
		const yaml = `
branch:
  schema:
    type: object
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects a branch object missing schema", () => {
		const yaml = `
branch:
  prompt: "Propose a name"
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects a branch object with unknown keys", () => {
		const yaml = `
branch:
  prompt: "Propose a name"
  schema: { type: object }
  bogus: true
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("accepts a step with an output_schema (raw JSON Schema)", () => {
		const yaml = `
branch: my-branch
steps:
  - name: summarise
    prompt: Summarise the issue
    model: claude-sonnet-4-6
    output_schema:
      type: object
      properties:
        title:
          type: string
      required: [title]
${validChangeRequest}`;

		const result = parse(yaml);

		expect(result.steps).toEqual([
			{
				name: "summarise",
				prompt: "Summarise the issue",
				resume_previous: false,
				measure_diff: false,
				model: "claude-sonnet-4-6",
				output_schema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
		]);
	});

	it("accepts a step with an allowed_tools list", () => {
		const yaml = `
branch: my-branch
steps:
  - name: summarise
    prompt: Summarise the issue
    model: claude-haiku-4-5
    allowed_tools: [Read, Glob, Grep]
${validChangeRequest}`;

		const result = parse(yaml);

		expect(result.steps).toEqual([
			{
				name: "summarise",
				prompt: "Summarise the issue",
				resume_previous: false,
				measure_diff: false,
				model: "claude-haiku-4-5",
				allowed_tools: ["Read", "Glob", "Grep"],
			},
		]);
	});

	it("rejects a step with an empty allowed_tools list", () => {
		const yaml = `
branch: my-branch
steps:
  - name: summarise
    prompt: Summarise
    model: claude-haiku-4-5
    allowed_tools: []
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("rejects a step missing model", () => {
		const yaml = `
branch: my-branch
steps:
  - name: review
    prompt: Review it
${validChangeRequest}`;

		expect(() => parse(yaml)).toThrow();
	});

	it("throws on invalid YAML", () => {
		const yaml = ":\n  :\n    - ][";

		expect(() => parse(yaml)).toThrow();
	});
});
