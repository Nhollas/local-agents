import { Effect, Ref } from "effect";
import type { RunContext } from "../../runner/runner.ts";
import type { PhaseFailure, PhaseFailureCause } from "./errors.ts";
import type { Phase, PhaseName, RunState } from "./types.ts";

type ObserveDeps = {
	lastState: Ref.Ref<RunState>;
	emit: RunContext["emit"];
};

export const withObservability =
	(deps: ObserveDeps) =>
	(name: PhaseName, phase: Phase): Phase =>
	(s) =>
		phase(s).pipe(
			Effect.tap((next) => Ref.set(deps.lastState, next)),
			Effect.tap((next) =>
				Effect.sync(() => emitPhaseSuccess(deps.emit, name, next)),
			),
			Effect.tapError((err) =>
				Effect.gen(function* () {
					const error = formatPhaseCause(err.cause);
					yield* Effect.annotateCurrentSpan({
						failure_phase: err.phase,
						failure_error: error,
					});
					recordPhaseFailure(deps.emit, err);
				}),
			),
			Effect.withSpan(`phase_${name}`),
		);

// Translates the new PHASE_ORDER name to the FinalizeFailurePhase persisted on the run row.
export function toFinalizeFailurePhase(
	name: PhaseName,
): "push" | "change_request" | "tracker_transition" | null {
	if (name === "push") return "push";
	if (name === "change_request") return "change_request";
	if (name === "tracker") return "tracker_transition";
	return null;
}

export function formatPhaseCause(cause: PhaseFailureCause): string {
	if (cause._tag === "WorkspaceCommandError") {
		const parts = [cause.message];
		const stderr = cause.stderr.trim();
		const stdout = cause.stdout.trim();
		if (stderr) parts.push(`stderr:\n${stderr}`);
		if (stdout) parts.push(`stdout:\n${stdout}`);
		return parts.join("\n");
	}
	if ("message" in cause && typeof cause.message === "string") {
		return cause.message;
	}
	return cause._tag;
}

function emitPhaseSuccess(
	emit: RunContext["emit"],
	name: PhaseName,
	next: RunState,
): void {
	switch (name) {
		case "workspace":
			if (next.wsPath !== undefined) {
				emit({
					kind: "system",
					stepName: null,
					data: {
						message: "workspace prepared",
						command: null,
						path: next.wsPath,
						exitCode: null,
					},
				});
			}
			return;
		case "branch_resolver":
			if (next.branch !== undefined) {
				emit({
					kind: "system",
					stepName: null,
					data: {
						message: "branch resolved",
						command: null,
						path: next.branch,
						exitCode: null,
					},
				});
			}
			return;
		case "change_request":
			if (next.prUrl !== undefined) {
				emit({
					kind: "system",
					stepName: null,
					data: {
						message: "change request opened",
						command: null,
						path: next.prUrl,
						exitCode: null,
					},
				});
			}
			return;
		default:
			return;
	}
}

function recordPhaseFailure(emit: RunContext["emit"], err: PhaseFailure): void {
	const finalize = toFinalizeFailurePhase(err.phase);
	if (finalize) {
		emit({
			kind: "system",
			stepName: null,
			data: {
				message: `finalize failed: ${finalize}`,
				command: null,
				path: null,
				exitCode: null,
			},
		});
	}
}
