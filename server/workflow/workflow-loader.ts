import { readFileSync } from "node:fs";
import type { RepoSlug } from "../types/brands.ts";
import type { RepoWorkflow } from "./workflow.ts";
import { parseRepoWorkflow } from "./workflow.ts";

const WORKFLOW_PATH = "workflow.yaml";

export function loadWorkflow(path = WORKFLOW_PATH): RepoWorkflow {
	const content = readFileSync(path, "utf-8");
	return parseRepoWorkflow(content);
}

export function createWorkflowMap(
	repos: RepoSlug[],
	workflow: RepoWorkflow,
): Map<RepoSlug, RepoWorkflow> {
	return new Map(repos.map((repo) => [repo, workflow]));
}
