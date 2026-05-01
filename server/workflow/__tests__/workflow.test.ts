import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import { issueKey, issueNumber } from "../../types/brands.ts";
import { parseRepoWorkflow, renderPrompt } from "../workflow.ts";

const baseIssue: Issue = {
	key: issueKey("owner/repo#1"),
	number: issueNumber(1),
	title: "Fix the thing",
	description: "Detailed description",
	labels: ["bug", "urgent"],
	url: "https://github.com/owner/repo/issues/1",
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

	it("renders the attempt variable", () => {
		const result = renderPrompt("Attempt #{{ attempt }}", {
			issue: baseIssue,
			attempt: 3,
		});

		expect(result).toBe("Attempt #3");
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
    output_schema: { type: object }
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("throws on invalid YAML", () => {
		const yaml = ":\n  :\n    - ][";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});
});
