import { FetchHttpClient } from "@effect/platform";
import { NodeCommandExecutor, NodeFileSystem } from "@effect/platform-node";
import {
	Config,
	Effect,
	Layer,
	Logger,
	LogLevel,
	ManagedRuntime,
} from "effect";

const MinimumLogLevelLive = Layer.unwrapEffect(
	Config.logLevel("LOG_LEVEL").pipe(
		Config.withDefault(LogLevel.Info),
		Effect.map(Logger.minimumLogLevel),
		Effect.orElseSucceed(() => Logger.minimumLogLevel(LogLevel.Info)),
	),
);

export const AppLayer = Layer.mergeAll(
	FetchHttpClient.layer,
	NodeFileSystem.layer,
	NodeCommandExecutor.layer.pipe(Layer.provide(NodeFileSystem.layer)),
	Logger.pretty,
	MinimumLogLevelLive,
);

export type AppRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof AppLayer>,
	never
>;

export function makeAppRuntime(): AppRuntime {
	return ManagedRuntime.make(AppLayer);
}
