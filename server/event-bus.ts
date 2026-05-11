import { EventEmitter } from "node:events";
import type { RunEvent } from "./event-schema.ts";

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

function emit(event: RunEvent): void {
	emitter.emit("run-event", event);
}

function on(handler: (event: RunEvent) => void): void {
	emitter.on("run-event", handler);
}

function off(handler: (event: RunEvent) => void): void {
	emitter.off("run-event", handler);
}

export const eventBus = { emit, on, off };
