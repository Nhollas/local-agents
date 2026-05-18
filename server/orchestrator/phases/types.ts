import type { CommandExecutor, FileSystem } from "@effect/platform";
import type { Effect } from "effect";
import type { AgentInvoker } from "../../workflow/agent-invoker.ts";
import type { WorkflowEventEmitter } from "../../workflow/event-emitter.ts";
import type { PhaseFailure, PhaseFailureCause } from "./errors.ts";
import type { PhaseInputs } from "./inputs.ts";

export type PhaseName =
	| "workspace"
	| "branch_resolver"
	| "ensure_branch"
	| "skills"
	| "setup"
	| "steps"
	| "push"
	| "change_request"
	| "tracker";

export type RunState = {
	wsPath?: string;
	branch?: string;
	workspaceEnv?: Record<string, string>;
	outputs?: Record<string, unknown>;
	prUrl?: string;
};

export type RunResult =
	| { status: "completed"; state: RunState }
	| {
			status: "failed";
			phase: PhaseName;
			cause: PhaseFailureCause;
			state: RunState;
	  };

// Widened by each phase slice as it consumes services; the walker will surface the full union in slice 5.
export type PhaseDeps =
	| PhaseInputs
	| FileSystem.FileSystem
	| CommandExecutor.CommandExecutor
	| AgentInvoker
	| WorkflowEventEmitter;

export type Phase = (
	s: RunState,
) => Effect.Effect<RunState, PhaseFailure, PhaseDeps>;
