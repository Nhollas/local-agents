import { describe, expect, it } from "vitest";
import type { Issue } from "../../trackers/types.ts";
import {
	getWorkflowPhases,
	parseRepoWorkflow,
	renderPrompt,
} from "../workflow.ts";

const baseIssue: Issue = {
	key: "owner/repo#1",
	number: 1,
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

describe("parseRepoWorkflow", () => {
	it("accepts a single-prompt workflow and applies defaults", () => {
		const yaml = "prompt: Fix this issue\n";

		const result = parseRepoWorkflow(yaml);

		expect(result.branch).toBe("agent/issue-{{ issue.number }}");
		expect(result.base_branch).toBe("main");
		expect(result.prompt).toBe("Fix this issue");
		expect(getWorkflowPhases(result)).toEqual([
			{ name: "prompt", prompt: "Fix this issue", resume_previous: false },
		]);
	});

	it("accepts a phased workflow", () => {
		const yaml = `
phases:
  - name: plan
    prompt: Write a plan
  - name: implement
    prompt: Implement the plan
    resume_previous: true
`;

		const result = parseRepoWorkflow(yaml);

		expect(result.prompt).toBeUndefined();
		expect(getWorkflowPhases(result)).toEqual([
			{ name: "plan", prompt: "Write a plan", resume_previous: false },
			{
				name: "implement",
				prompt: "Implement the plan",
				resume_previous: true,
			},
		]);
	});

	it("rejects missing prompt", () => {
		const yaml = "branch: my-branch\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});

	it("rejects workflows with both prompt and phases", () => {
		const yaml = `
prompt: Fix this issue
phases:
  - name: plan
    prompt: Write a plan
`;

		expect(() => parseRepoWorkflow(yaml)).toThrow(
			/Workflow must define exactly one of prompt or phases/,
		);
	});

	it("rejects workflows with neither prompt nor phases", () => {
		const yaml = "branch: my-branch\n";

		expect(() => parseRepoWorkflow(yaml)).toThrow(
			/Workflow must define exactly one of prompt or phases/,
		);
	});

	it("throws on invalid YAML", () => {
		const yaml = ":\n  :\n    - ][";

		expect(() => parseRepoWorkflow(yaml)).toThrow();
	});
});
