import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber, repoSlug } from "../../types/brands.ts";
import { parseRepoWorkflow, renderPrompt } from "../workflow.ts";

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
	it("returns empty string for a missing variable", () => {
		const result = renderPrompt("Hello {{ issue.nonexistent }}", {
			issue: baseIssue,
		});

		expect(result).toBe("Hello ");
	});

	it("returns empty string when null appears in path traversal", () => {
		const result = renderPrompt("Value: {{ issue.labels.deep.path }}", {
			issue: baseIssue,
		});

		expect(result).toBe("Value: ");
	});

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

	it("resolves a nested scalar step output reference", () => {
		const result = renderPrompt(
			"Heading: {{ steps.summarise.output.summary.title }}",
			{
				issue: baseIssue,
				outputs: {
					summarise: { summary: { title: "Deep" } },
				},
			},
		);

		expect(result).toBe("Heading: Deep");
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

	it("renders an array output value as JSON.stringify(value)", () => {
		const result = renderPrompt("Tags: {{ steps.summarise.output.tags }}", {
			issue: baseIssue,
			outputs: { summarise: { tags: ["a", "b"] } },
		});

		expect(result).toBe('Tags: ["a","b"]');
	});

	it("renders an unknown step reference as empty string", () => {
		const result = renderPrompt("Title: {{ steps.missing.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Hello" } },
		});

		expect(result).toBe("Title: ");
	});

	it("renders an unknown nested field as empty string", () => {
		const result = renderPrompt(
			"Title: {{ steps.summarise.output.title.deep }}",
			{
				issue: baseIssue,
				outputs: { summarise: { title: "Hello" } },
			},
		);

		expect(result).toBe("Title: ");
	});

	it("renders empty string when outputs are not provided", () => {
		const result = renderPrompt("Title: {{ steps.summarise.output.title }}", {
			issue: baseIssue,
		});

		expect(result).toBe("Title: ");
	});

	it("renders a too-short steps reference as empty string", () => {
		const result = renderPrompt("X={{ steps.summarise }}", {
			issue: baseIssue,
			outputs: { summarise: { title: "Hello" } },
		});

		expect(result).toBe("X=");
	});

	it("renders a steps reference without the output keyword as empty string", () => {
		const result = renderPrompt("X={{ steps.summarise.notoutput.title }}", {
			issue: baseIssue,
			outputs: { summarise: { notoutput: { title: "Hello" } } },
		});

		expect(result).toBe("X=");
	});

	it("renders a null output value as empty string", () => {
		const result = renderPrompt("X={{ steps.summarise.output.title }}", {
			issue: baseIssue,
			outputs: { summarise: { title: null } },
		});

		expect(result).toBe("X=");
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
base_branch: main
steps:
  - name: implement
    prompt: Fix this issue
${validChangeRequest}`;

		const result = parseRepoWorkflow(yaml);

		expect(result).toEqual({
			branch: "agent/issue-{{ issue.number }}",
			base_branch: "main",
			steps: [
				{ name: "implement", prompt: "Fix this issue", resume_previous: false },
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
base_branch: main
steps:
  - name: plan
    prompt: Write a plan
  - name: implement
    prompt: Implement the plan
    resume_previous: true
${validChangeRequest}`;

		const result = parseRepoWorkflow(yaml);

		expect(result.steps).toEqual([
			{ name: "plan", prompt: "Write a plan", resume_previous: false },
			{
				name: "implement",
				prompt: "Implement the plan",
				resume_previous: true,
			},
		]);
	});

	it("rejects workflows missing change_request", () => {
		const yaml = `
branch: my-branch
base_branch: main
steps:
  - name: implement
    prompt: Fix it
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects change_request missing title", () => {
		const yaml = `
branch: my-branch
base_branch: main
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
base_branch: main
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
base_branch: main
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
		const yaml = "base_branch: main\nsteps:\n  - name: x\n    prompt: Fix it\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows missing base_branch", () => {
		const yaml = "branch: agent/x\nsteps:\n  - name: x\n    prompt: Fix it\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows missing steps", () => {
		const yaml = "branch: my-branch\nbase_branch: main\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows with an empty steps array", () => {
		const yaml = "branch: my-branch\nbase_branch: main\nsteps: []\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects the legacy top-level prompt form", () => {
		const yaml = `
branch: my-branch
base_branch: main
prompt: Fix this issue
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects the legacy phases key", () => {
		const yaml = `
branch: my-branch
base_branch: main
phases:
  - name: plan
    prompt: Write a plan
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects the legacy hooks block", () => {
		const yaml = `
branch: my-branch
base_branch: main
hooks:
  before_run: echo hi
steps:
  - name: implement
    prompt: Fix it
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects unknown step keys", () => {
		const yaml = `
branch: my-branch
base_branch: main
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
  schema:
    type: object
    properties:
      name:
        type: string
        pattern: "^feat/"
    required: [name]
base_branch: main
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		const result = parseRepoWorkflow(yaml);

		expect(result.branch).toEqual({
			prompt: "Propose a name for {{ issue.key }}",
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
base_branch: main
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
base_branch: main
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
base_branch: main
steps:
  - name: implement
    prompt: Fix it
${validChangeRequest}`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("accepts a step with an output_schema (raw JSON Schema)", () => {
		const yaml = `
branch: my-branch
base_branch: main
steps:
  - name: summarise
    prompt: Summarise the issue
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
				output_schema: {
					type: "object",
					properties: { title: { type: "string" } },
					required: ["title"],
				},
			},
		]);
	});

	it("throws on invalid YAML", () => {
		const yaml = ":\n  :\n    - ][";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});
});
