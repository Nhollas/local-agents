import type { PlatformError } from "@effect/platform/Error";
import { Data } from "effect";
import type { CodeHostError } from "../../code-hosts/errors.ts";
import type { TrackerError } from "../../trackers/errors.ts";
import type { WorkflowExecutionError } from "../../workflow/errors.ts";
import type { WorkspaceCommandError } from "../workspace.ts";
import type { PhaseName } from "./types.ts";

export type PhaseFailureCause =
	| WorkspaceCommandError
	| WorkflowExecutionError
	| CodeHostError
	| TrackerError
	| PlatformError
	| { _tag: "PhaseSetupError"; message: string };

export class PhaseFailure extends Data.TaggedError("PhaseFailure")<{
	phase: PhaseName;
	cause: PhaseFailureCause;
}> {}
