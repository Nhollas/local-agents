import { Effect, ParseResult, Schema } from "effect";
import { parse as parseYaml } from "yaml";
import { WorkflowParseError } from "./errors.ts";
import { RepoWorkflowSchema } from "./schemas.ts";
import type { RepoWorkflow } from "./types.ts";

export const parseRepoWorkflow = (
	yamlContent: string,
): Effect.Effect<RepoWorkflow, WorkflowParseError> =>
	Effect.gen(function* () {
		const yamlDocument = yield* Effect.try({
			try: () => parseYaml(yamlContent),
			catch: (err) =>
				new WorkflowParseError({
					message: err instanceof Error ? err.message : String(err),
				}),
		});
		return yield* decodeRepoWorkflow(yamlDocument).pipe(
			Effect.mapError(
				(err) =>
					new WorkflowParseError({
						message: ParseResult.TreeFormatter.formatErrorSync(err),
					}),
			),
		);
	});

const decodeRepoWorkflow = Schema.decodeUnknown(RepoWorkflowSchema, {
	onExcessProperty: "error",
});
