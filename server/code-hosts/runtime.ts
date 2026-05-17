import { FetchHttpClient } from "@effect/platform";
import { Layer, Logger, ManagedRuntime } from "effect";

export const CodeHostLayer = Layer.mergeAll(
	FetchHttpClient.layer,
	Logger.pretty,
);

export type CodeHostRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof CodeHostLayer>,
	never
>;

export function makeCodeHostRuntime(): CodeHostRuntime {
	return ManagedRuntime.make(CodeHostLayer);
}
