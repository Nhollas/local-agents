import { FetchHttpClient } from "@effect/platform";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import { Layer, Logger, ManagedRuntime } from "effect";

export const AppLayer = Layer.mergeAll(
	FetchHttpClient.layer,
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
	Logger.pretty,
);

export type AppRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof AppLayer>,
	never
>;

export function makeAppRuntime(): AppRuntime {
	return ManagedRuntime.make(AppLayer);
}
