import { Context } from "effect";
import type { CodeHostAdapter } from "../../code-hosts/types.ts";
import type { RunRepository } from "../../run-repository.ts";
import type { RunContext } from "../../runner/runner.ts";
import type { Issue, TrackerAdapter } from "../../trackers/types.ts";
import type { RepoSlug, RunId } from "../../types/brands.ts";
import type { PromptScope, RepoWorkflow } from "../../workflow/types.ts";

type PhaseInputsShape = {
	readonly issue: Issue;
	readonly repo: RepoSlug;
	readonly cloneUrl: string;
	readonly baseBranch: string;
	readonly runId: RunId;
	readonly workspaceRoot: string;
	readonly skillsSourceDir: string;
	readonly agentEnv: Record<string, string>;
	readonly scope: PromptScope;
	readonly workflow: RepoWorkflow;
	// Side-effect sinks each pre-engine phase needs to write through. Kept on PhaseInputs
	// rather than as separate tags until slice 5 shows whether they need to split.
	readonly runRepo: RunRepository;
	readonly emit: RunContext["emit"];
	readonly codeHost: CodeHostAdapter;
	readonly tracker: TrackerAdapter;
};

export class PhaseInputs extends Context.Tag("PhaseInputs")<
	PhaseInputs,
	PhaseInputsShape
>() {}
