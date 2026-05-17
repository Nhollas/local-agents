import { FetchHttpClient } from "@effect/platform";
import { Layer, Logger, ManagedRuntime } from "effect";

export const TrackerLayer = Layer.mergeAll(
	FetchHttpClient.layer,
	Logger.pretty,
);

export type TrackerRuntime = ManagedRuntime.ManagedRuntime<
	Layer.Layer.Success<typeof TrackerLayer>,
	never
>;

export function makeTrackerRuntime(): TrackerRuntime {
	return ManagedRuntime.make(TrackerLayer);
}
