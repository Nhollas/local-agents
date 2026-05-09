import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorkflow } from "./workflow-loader.ts";

const validWorkflowYaml = `
branch: "agent/issue-{{ issue.number }}"
steps:
  - name: implement
    prompt: "Fix the issue"
change_request:
  title: "PR for {{ issue.key }}"
  body: "Closes {{ issue.key }}"
`;

type TestWorkflowFile = {
	path: string;
	[Symbol.dispose](): void;
};

function writeWorkflow(contents: string): TestWorkflowFile {
	const dir = mkdtempSync(join(tmpdir(), "local-agents-workflow-"));
	const path = join(dir, "workflow.yaml");
	writeFileSync(path, contents);
	return {
		path,
		[Symbol.dispose]() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

describe("loadWorkflow", () => {
	it("loads and parses a local workflow file", () => {
		using workflowFile = writeWorkflow(validWorkflowYaml);

		const workflow = loadWorkflow(workflowFile.path);

		expect(workflow).toEqual({
			branch: "agent/issue-{{ issue.number }}",
			steps: [
				{ name: "implement", prompt: "Fix the issue", resume_previous: false },
			],
			change_request: {
				title: "PR for {{ issue.key }}",
				body: "Closes {{ issue.key }}",
			},
		});
	});

	it("fails clearly when the local workflow is missing", () => {
		expect(() =>
			loadWorkflow(join(tmpdir(), "local-agents-missing-workflow.yaml")),
		).toThrow(/ENOENT/);
	});

	it("fails clearly when the local workflow YAML is invalid", () => {
		using workflowFile = writeWorkflow(":\n  :\n    - ][");

		expect(() => loadWorkflow(workflowFile.path)).toThrow();
	});

	it("rejects an output reference that points at a step the workflow doesn't define", () => {
		using workflowFile = writeWorkflow(`
branch: agent
steps:
  - name: implement
    prompt: "Use {{ steps.missing.output.title }}"
change_request:
  title: "PR"
  body: "Closes"
`);

		expect(() => loadWorkflow(workflowFile.path)).toThrow(
			new RegExp(
				`${workflowFile.path}.*steps\\.missing\\.output\\.title.*unknown step "missing"`,
				"s",
			),
		);
	});

	it("loads cleanly when output references resolve through the schema", () => {
		using workflowFile = writeWorkflow(`
branch: agent
steps:
  - name: summarise
    prompt: "Write a summary"
    output_schema:
      type: object
      properties:
        title: { type: string }
  - name: implement
    prompt: "Use {{ steps.summarise.output.title }}"
change_request:
  title: "PR: {{ steps.summarise.output.title }}"
  body: "Closes"
`);

		expect(() => loadWorkflow(workflowFile.path)).not.toThrow();
	});
});
