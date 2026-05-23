import { Effect, type Queue } from "effect";
import type { AgentMessage } from "./agent-invoker.ts";
import type { WorkflowExecutionError } from "./errors.ts";
import type { StepUsage } from "./types.ts";

type AssistantMessage = Extract<AgentMessage, { type: "assistant" }>;

export type WorkflowEvent =
	| { _tag: "BranchAssistantMessage"; message: AssistantMessage }
	| { _tag: "BranchResolved"; name: string; usage: StepUsage }
	| {
			_tag: "BranchFailed";
			error: WorkflowExecutionError;
			usage: StepUsage;
	  }
	| { _tag: "StepStarted"; name: string; index: number; total: number }
	| {
			_tag: "StepAssistantMessage";
			stepName: string;
			message: AssistantMessage;
	  }
	| { _tag: "StepToolFailure"; stepName: string; toolName: string }
	| {
			_tag: "StepResult";
			stepName: string;
			structuredOutput?: unknown | undefined;
			sessionId: string;
			usage: StepUsage;
	  }
	| {
			_tag: "StepCompleted";
			stepName: string;
			index: number;
			durationMs: number;
	  }
	| {
			_tag: "StepFailed";
			stepName: string;
			index: number;
			error: WorkflowExecutionError;
			durationMs: number;
	  };

interface WorkflowEventEmitterService {
	readonly emit: (event: WorkflowEvent) => Effect.Effect<void>;
}

export class WorkflowEventEmitter extends Effect.Service<WorkflowEventEmitter>()(
	"WorkflowEventEmitter",
	{
		effect: (queue: Queue.Enqueue<WorkflowEvent>) =>
			Effect.succeed<WorkflowEventEmitterService>({
				emit: (event) => Effect.asVoid(queue.offer(event)),
			}),
	},
) {}
