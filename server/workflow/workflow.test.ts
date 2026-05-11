import { describe, expect, it } from "vitest";
import type { Issue } from "../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../types/brands.ts";
import { parseRepoWorkflow, renderPrompt } from "./workflow.ts";

const baseIssue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	repo: repoSlug("owner/repo"),
	title: "Fix the thing",
	description: "Detailed description",
	labels: ["bug", "urgent"],
	url: "https://gitlab.example.test/owner/repo/-/issues/1",
	createdAt: "2026-01-01T00:00:00Z",
};

describe("renderPrompt", () => {
	it("joins array variables with comma", () => {
		const result = renderPrompt("Labels: {{ issue.labels }}", {
			issue: baseIssue,
		});

		expect(result).toBe("Labels: bug, urgent");
	});

	it("resolves a top-level scalar step output reference", () => {
		const result = renderPrompt("Title: {{ steps.summarise.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Hello" } },
		});

		expect(result).toBe("Title: Hello");
	});

	it("renders an object output value as JSON.stringify(value)", () => {
		const result = renderPrompt(
			"Summary: {{ steps.summarise.output.summary }}",
			{
				issue: baseIssue,
				outputs: {
					summarise: { summary: { title: "Deep", count: 2 } },
				},
			},
		);

		expect(result).toBe('Summary: {"title":"Deep","count":2}');
	});

	it("does not re-substitute templates that appear inside an output value", () => {
		const result = renderPrompt("Title: {{ steps.summarise.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Has {{ issue.key }} inside" } },
		});

		expect(result).toBe("Title: Has {{ issue.key }} inside");
	});
});

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

		const result = parseRepoWorkflow(yaml);

		expect(result).toEqual({
			branch: "agent/issue-{{ issue.number }}",
			steps: [
				{
					name: "implement",
					prompt: "Fix this issue",
					resume_previous: false,
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

		const result = parseRepoWorkflow(yaml);

		expect(result.steps).toEqual([
			{
				name: "plan",
				prompt: "Write a plan",
				resume_previous: false,
				model: "claude-sonnet-4-6",
			},
			{
				name: "implement",
				prompt: "Implement the plan",
				resume_previous: true,
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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows missing branch", () => {
		const yaml = "steps:\n  - name: x\n    prompt: Fix it\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows missing steps", () => {
		const yaml = "branch: my-branch\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows with an empty steps array", () => {
		const yaml = "branch: my-branch\nsteps: []\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects unknown step keys", () => {
		const yaml = `
branch: my-branch
steps:
  - name: implement
    prompt: Fix it
    bogus: value
${validChangeRequest}`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		const result = parseRepoWorkflow(yaml);

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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects a branch object missing schema", () => {
		const yaml = `
branch:
  prompt: "Propose a name"
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		expect(() => parseRepoWorkflow(yaml)).toThrow();
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

		const result = parseRepoWorkflow(yaml);

		expect(result.steps).toEqual([
			{
				name: "summarise",
				prompt: "Summarise the issue",
				resume_previous: false,
				model: "claude-sonnet-4-6",
				output_schema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
		]);
	});

	it("rejects a step missing model", () => {
		const yaml = `
branch: my-branch
steps:
  - name: review
    prompt: Review it
${validChangeRequest}`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("throws on invalid YAML", () => {
		const yaml = ":\n  :\n    - ][";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});
});
