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
import { TelemetryLive } from "./telemetry.ts";

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

export function makeAppRuntime(
	extra: Layer.Layer<never> = Layer.empty,
): AppRuntime {
	return ManagedRuntime.make(Layer.mergeAll(AppLayer, extra));
}

export function makeServerRuntime(): AppRuntime {
	return makeAppRuntime(TelemetryLive);
}
