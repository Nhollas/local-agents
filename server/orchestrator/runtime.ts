import { Layer, Logger, ManagedRuntime } from "effect";

const OrchestratorLayer = Layer.mergeAll(Logger.pretty);

export function makeOrchestratorRuntime() {
	return ManagedRuntime.make(OrchestratorLayer);
}
