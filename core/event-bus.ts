import { EventEmitter } from "node:events";
import type { RunEventType } from "./schema.ts";

export type RunEvent = {
  type: RunEventType;
  runId: string;
  agentName: string;
  data: Record<string, unknown>;
  createdAt: string;
};

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
