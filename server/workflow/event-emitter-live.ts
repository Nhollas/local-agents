import { Effect, Layer, type Queue } from "effect";
import { type WorkflowEvent, WorkflowEventEmitter } from "./event-emitter.ts";

export type { WorkflowEvent } from "./event-emitter.ts";

export const WorkflowEventEmitterLive = (
	queue: Queue.Enqueue<WorkflowEvent>,
): Layer.Layer<WorkflowEventEmitter> =>
	Layer.succeed(WorkflowEventEmitter, {
		emit: (event) => Effect.asVoid(queue.offer(event)),
	});
