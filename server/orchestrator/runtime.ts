import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Layer, Logger, ManagedRuntime } from "effect";

export const OrchestratorLayer = Layer.mergeAll(
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
	Logger.pretty,
);

export type OrchestratorRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof OrchestratorLayer>,
	never
>;

export function makeOrchestratorRuntime(): OrchestratorRuntime {
	return ManagedRuntime.make(OrchestratorLayer);
}
