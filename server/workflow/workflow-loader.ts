import { readFileSync } from "node:fs";
import type { RepoWorkflow } from "./workflow.ts";
import { parseRepoWorkflow } from "./workflow.ts";

const WORKFLOW_PATH = "workflow.yaml";

export function loadWorkflow(path = WORKFLOW_PATH): RepoWorkflow {
	const content = readFileSync(path, "utf-8");
	return parseRepoWorkflow(content);
}

export function createWorkflowMap(
	repos: string[],
	workflow: RepoWorkflow,
): Map<string, RepoWorkflow> {
	return new Map(repos.map((repo) => [repo, workflow]));
}
