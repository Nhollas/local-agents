import { EventEmitter } from "node:events";
import type {
	RunCompletedData,
	RunFailedData,
	RunOutputData,
	RunStartedData,
	RunToolUseData,
	StepCompletedData,
	StepFailedData,
	StepStartedData,
} from "./db/schema.ts";
import type { RunId } from "./types/brands.ts";

type RunEventBase = {
	runId: RunId;
	agentName: string;
	createdAt: string;
};

export type StepEvent =
	| { type: "step.started"; data: StepStartedData }
	| { type: "step.completed"; data: StepCompletedData }
	| { type: "step.failed"; data: StepFailedData };

export type RunEvent =
	| (RunEventBase & { type: "run:started"; data: RunStartedData })
	| (RunEventBase & { type: "run:output"; data: RunOutputData })
	| (RunEventBase & { type: "run:tool_use"; data: RunToolUseData })
	| (RunEventBase & StepEvent)
	| (RunEventBase & { type: "run:completed"; data: RunCompletedData })
	| (RunEventBase & { type: "run:failed"; data: RunFailedData });

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
