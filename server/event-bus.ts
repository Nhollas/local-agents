import { EventEmitter } from "node:events";
import { Effect, Metric } from "effect";
import type { RunEvent } from "./event-schema.ts";

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

const eventsEmitted = Metric.counter("event_bus.events_emitted_total", {
	description: "RunEvents published on the bus, tagged by kind.",
	incremental: true,
});

function emit(event: RunEvent): void {
	Effect.runSync(
		Metric.update(eventsEmitted.pipe(Metric.tagged("kind", event.kind)), 1),
	);
	emitter.emit("run-event", event);
}

function on(handler: (event: RunEvent) => void): void {
	emitter.on("run-event", handler);
}

function off(handler: (event: RunEvent) => void): void {
	emitter.off("run-event", handler);
}

export const eventBus = { emit, on, off };
