import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Layer, Logger, ManagedRuntime } from "effect";

export const WorkflowLayer = Layer.mergeAll(
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
	Logger.pretty,
);

export type WorkflowRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof WorkflowLayer>,
	never
>;

export function makeWorkflowRuntime(): WorkflowRuntime {
	return ManagedRuntime.make(WorkflowLayer);
}
