import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeAppRuntime } from "../runtime.ts";
import { loadWorkflow } from "./loader.ts";

const runtime = makeAppRuntime();
afterAll(() => runtime.dispose());

const load = (path?: string) => runtime.runPromise(loadWorkflow(path));

const validWorkflowYaml = `
branch: "agent/issue-{{ issue.number }}"
steps:
  - name: implement
    prompt: "Fix the issue"
    model: claude-sonnet-4-6
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
	it("loads and parses a local workflow file", async () => {
		using workflowFile = writeWorkflow(validWorkflowYaml);

		const workflow = await load(workflowFile.path);

		expect(workflow).toEqual({
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
		});
	});

	it("fails clearly when the local workflow is missing", async () => {
		await expect(
			load(join(tmpdir(), "local-agents-missing-workflow.yaml")),
		).rejects.toThrow(/ENOENT/);
	});

	it("fails clearly when the local workflow YAML is invalid", async () => {
		using workflowFile = writeWorkflow(":\n  :\n    - ][");

		await expect(load(workflowFile.path)).rejects.toThrow();
	});

	it("rejects an output reference that points at a step the workflow doesn't define", async () => {
		using workflowFile = writeWorkflow(`
branch: agent
steps:
  - name: implement
    prompt: "Use {{ steps.missing.output.title }}"
    model: claude-sonnet-4-6
change_request:
  title: "PR"
  body: "Closes"
`);

		await expect(load(workflowFile.path)).rejects.toThrow(
			new RegExp(
				`${workflowFile.path}.*steps\\.missing\\.output\\.title.*unknown step "missing"`,
				"s",
			),
		);
	});

	it("loads cleanly when output references resolve through the schema", async () => {
		using workflowFile = writeWorkflow(`
branch: agent
steps:
  - name: summarise
    prompt: "Write a summary"
    model: claude-sonnet-4-6
    output_schema:
      type: object
      properties:
        title: { type: string }
  - name: implement
    prompt: "Use {{ steps.summarise.output.title }}"
    model: claude-sonnet-4-6
change_request:
  title: "PR: {{ steps.summarise.output.title }}"
  body: "Closes"
`);

		await expect(load(workflowFile.path)).resolves.toBeDefined();
	});
});
