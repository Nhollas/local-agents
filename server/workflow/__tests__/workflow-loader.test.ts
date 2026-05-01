import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoSlug } from "../../types/brands.ts";
import { createWorkflowMap, loadWorkflow } from "../workflow-loader.ts";

const validWorkflowYaml = `
branch: "agent/issue-{{ issue.number }}"
base_branch: "main"
steps:
  - name: implement
    prompt: "Fix the issue"
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
			base_branch: "main",
			steps: [
				{ name: "implement", prompt: "Fix the issue", resume_previous: false },
			],
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
});

describe("createWorkflowMap", () => {
	it("applies the same loaded workflow to every configured repo", () => {
		using workflowFile = writeWorkflow(validWorkflowYaml);
		const workflow = loadWorkflow(workflowFile.path);

		const workflows = createWorkflowMap(
			[repoSlug("test-owner/first-repo"), repoSlug("test-owner/second-repo")],
			workflow,
		);

		expect(workflows).toEqual(
			new Map([
				["test-owner/first-repo", workflow],
				["test-owner/second-repo", workflow],
			]),
		);
	});
});
