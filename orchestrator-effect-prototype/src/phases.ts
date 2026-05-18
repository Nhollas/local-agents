// THROWAWAY PROTOTYPE — see ../NOTES.md
// Shared phase definitions used by all four variants. Each phase is a pure
// (state) => Effect<state, PhaseFailure> function. The variants differ only in
// how they compose these phases into a walk.

import { Data, Effect } from "effect";

export type PhaseName =
	| "workspace"
	| "branch_resolver"
	| "skills"
	| "setup"
	| "steps"
	| "push"
	| "change_request"
	| "tracker";

export const PHASE_ORDER: readonly PhaseName[] = [
	"workspace",
	"branch_resolver",
	"skills",
	"setup",
	"steps",
	"push",
	"change_request",
	"tracker",
];

export class PhaseFailure extends Data.TaggedError("PhaseFailure")<{
	phase: PhaseName;
	message: string;
}> {}

export type RunState = {
	wsPath?: string;
	branch?: string;
	outputs?: Record<string, unknown>;
	prUrl?: string;
};

export type RunResult =
	| { status: "completed"; state: RunState }
	| {
			status: "failed";
			phase: PhaseName;
			error: string;
			state: RunState;
	  };

export type Scenario = {
	failAt: PhaseName | null;
	abortAfter: PhaseName | null;
};

export type Phase = (s: RunState) => Effect.Effect<RunState, PhaseFailure>;

// Sink for trace lines. The TUI installs a fresh array per run, the phases push
// into it. Equivalent in spirit to the real WorkflowEventEmitter Queue — kept
// as a plain array here because the prototype is about phase-walk shape, not
// event-emission shape.
export type Trace = string[];

export function makePhases(
	scenario: Scenario,
	trace: Trace,
): Record<PhaseName, Phase> {
	return {
		workspace: phase("workspace", scenario, trace, (s) => ({
			...s,
			wsPath: "/tmp/ws/run-1",
		})),
		branch_resolver: phase("branch_resolver", scenario, trace, (s) => ({
			...s,
			branch: "agent/fix-foo",
		})),
		skills: phase("skills", scenario, trace, (s) => s),
		setup: phase("setup", scenario, trace, (s) => s),
		steps: phase("steps", scenario, trace, (s) => ({
			...s,
			outputs: { diff: "+1 -1" },
		})),
		push: phase("push", scenario, trace, (s) => s),
		change_request: phase("change_request", scenario, trace, (s) => ({
			...s,
			prUrl: "https://example.test/pr/1",
		})),
		tracker: phase("tracker", scenario, trace, (s) => s),
	};
}

function phase(
	name: PhaseName,
	scenario: Scenario,
	trace: Trace,
	apply: (s: RunState) => RunState,
): Phase {
	return (s) =>
		Effect.gen(function* () {
			trace.push(`  > ${name}`);
			if (scenario.failAt === name) {
				trace.push(`  x ${name} (injected failure)`);
				return yield* Effect.fail(
					new PhaseFailure({
						phase: name,
						message: `injected failure at ${name}`,
					}),
				);
			}
			const next = apply(s);
			trace.push(`  v ${name}`);
			if (scenario.abortAfter === name) {
				trace.push(`  ! aborting after ${name}`);
				return yield* Effect.interrupt;
			}
			return next;
		});
}
