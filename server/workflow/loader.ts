import { FileSystem } from "@effect/platform";
import { Effect } from "effect";
import { WorkflowParseError, type WorkflowValidationError } from "./errors.ts";
import { parseRepoWorkflow } from "./parse.ts";
import type { RepoWorkflow } from "./types.ts";
import { validateOutputReferences } from "./validator.ts";

const WORKFLOW_PATH = "workflow.yaml";

export const loadWorkflow = (
	path: string = WORKFLOW_PATH,
): Effect.Effect<
	RepoWorkflow,
	WorkflowParseError | WorkflowValidationError,
	FileSystem.FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem.FileSystem;
		const content = yield* fs
			.readFileString(path)
			.pipe(
				Effect.mapError(
					(err) => new WorkflowParseError({ message: err.message }),
				),
			);
		const workflow = yield* parseRepoWorkflow(content);
		yield* validateOutputReferences(workflow, path);
		return workflow;
	});
