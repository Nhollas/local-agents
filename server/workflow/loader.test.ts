import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { layer } from "@effect/vitest";
import { Effect } from "effect";
import { expect } from "vitest";
import { loadWorkflow } from "./loader.ts";

layer(NodeFileSystem.layer)("loadWorkflow", (it) => {
	it.effect("loads and parses a local workflow file", () =>
		Effect.gen(function* () {
			using workflowFile = writeWorkflow(validWorkflowYaml);

			const workflow = yield* loadWorkflow(workflowFile.path);

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
		}),
	);

	it.effect("fails clearly when the local workflow is missing", () =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				loadWorkflow(join(tmpdir(), "local-agents-missing-workflow.yaml")),
			);
			if (result._tag !== "Left") throw new Error("expected failure");
			expect(result.left.message).toMatch(/ENOENT/);
		}),
	);

	it.effect("fails clearly when the local workflow YAML is invalid", () =>
		Effect.gen(function* () {
			using workflowFile = writeWorkflow(":\n  :\n    - ][");

			const result = yield* Effect.either(loadWorkflow(workflowFile.path));
			expect(result._tag).toBe("Left");
		}),
	);

	it.effect(
		"rejects an output reference that points at a step the workflow doesn't define",
		() =>
			Effect.gen(function* () {
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

				const result = yield* Effect.either(loadWorkflow(workflowFile.path));
				if (result._tag !== "Left") throw new Error("expected failure");
				expect(result.left.message).toMatch(
					new RegExp(
						`${workflowFile.path}.*steps\\.missing\\.output\\.title.*unknown step "missing"`,
						"s",
					),
				);
			}),
	);

	it.effect(
		"loads cleanly when output references resolve through the schema",
		() =>
			Effect.gen(function* () {
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

				const workflow = yield* loadWorkflow(workflowFile.path);
				expect(workflow).toBeDefined();
			}),
	);
});

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
