import { readFileSync } from "node:fs";
import type { RepoWorkflow } from "./workflow.ts";
import { parseRepoWorkflow } from "./workflow.ts";
import { validateOutputReferences } from "./workflow-validator.ts";

const WORKFLOW_PATH = "workflow.yaml";

export function loadWorkflow(path = WORKFLOW_PATH): RepoWorkflow {
	const content = readFileSync(path, "utf-8");
	const workflow = parseRepoWorkflow(content);
	validateOutputReferences(workflow, path);
	return workflow;
}
