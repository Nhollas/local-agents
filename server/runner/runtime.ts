import { Layer, Logger, ManagedRuntime } from "effect";

const RunnerLayer = Layer.mergeAll(Logger.pretty);

export type RunnerRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof RunnerLayer>,
	never
>;

export function makeRunnerRuntime(): RunnerRuntime {
	return ManagedRuntime.make(RunnerLayer);
}
