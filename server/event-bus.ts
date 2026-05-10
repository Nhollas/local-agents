import { EventEmitter } from "node:events";
import type {
	AgentSayData,
	RunCompletedData,
	RunFailedData,
	RunStartedData,
	StepCompletedData,
	StepFailedData,
	StepStartedData,
	SystemData,
	ToolBashData,
	ToolEditData,
	ToolGrepData,
	ToolOtherData,
	ToolReadData,
} from "./db/schema.ts";
import type { RunId } from "./types/brands.ts";

type RunEventBase = {
	id: string;
	seq: number;
	runId: RunId;
	stepName: string | null;
	createdAt: string;
};

export type RunEvent =
	| (RunEventBase & { kind: "run:started"; data: RunStartedData })
	| (RunEventBase & { kind: "run:completed"; data: RunCompletedData })
	| (RunEventBase & { kind: "run:failed"; data: RunFailedData })
	| (RunEventBase & { kind: "step:started"; data: StepStartedData })
	| (RunEventBase & { kind: "step:completed"; data: StepCompletedData })
	| (RunEventBase & { kind: "step:failed"; data: StepFailedData })
	| (RunEventBase & { kind: "agent:say"; data: AgentSayData })
	| (RunEventBase & { kind: "tool:read"; data: ToolReadData })
	| (RunEventBase & { kind: "tool:edit"; data: ToolEditData })
	| (RunEventBase & { kind: "tool:grep"; data: ToolGrepData })
	| (RunEventBase & { kind: "tool:bash"; data: ToolBashData })
	| (RunEventBase & { kind: "tool:other"; data: ToolOtherData })
	| (RunEventBase & { kind: "system"; data: SystemData });

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
