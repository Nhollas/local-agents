// Single source of truth for the design content.
// Variants render different *views* over this data — but the facts come from here.

export type Side = "engine" | "orch" | "shared" | "deleted" | "moved" | "tbd";

export type FileNode = {
	path: string;
	role: string;
	side: Side;
	note?: string;
	group?: string; // grouping label inside workflow/ (data shape / contracts / impls / public / loader / private)
	movedTo?: string; // for moved-out files in orchestrator
	movedFrom?: string; // for moved-in files in workflow/
};

// ── workflow/ — 18 files, flat ────────────────────────────────────────────
export const workflowFiles: FileNode[] = [
	// data shape (3)
	{
		path: "workflow/types.ts",
		role: "RepoWorkflow, WorkflowStep, WorkflowBranch, ChangeRequestTemplate, PromptIssue, PromptScope",
		side: "engine",
		group: "data shape",
	},
	{
		path: "workflow/schemas.ts",
		role: "Effect/Schema definitions (existing, mostly unchanged)",
		side: "engine",
		group: "data shape",
	},
	{
		path: "workflow/errors.ts",
		role: "5 tagged errors + 3 unions (Definition / Execution / catchall)",
		side: "engine",
		group: "data shape",
	},

	// service contracts (3)
	{
		path: "workflow/runtime.ts",
		role: "WorkflowLayer + makeWorkflowRuntime (migration scaffolding)",
		side: "engine",
		group: "service contracts",
		note: "MIGRATION SCAFFOLDING — delete when a single app-wide ManagedRuntime in server.ts merges WorkflowLayer ⊕ TrackerLayer ⊕ CodeHostLayer ⊕ …",
	},
	{
		path: "workflow/agent-invoker.ts",
		role: "AgentInvoker Context.Tag + AgentInvokeOptions + AgentMessage",
		side: "engine",
		group: "service contracts",
	},
	{
		path: "workflow/event-emitter.ts",
		role: "WorkflowEventEmitter Context.Tag + WorkflowEvent ADT + StepUsage / ModelUsage",
		side: "engine",
		group: "service contracts",
	},

	// service implementations (4) — MOVED IN FROM orchestrator/
	{
		path: "workflow/agent-invoker-live.ts",
		role: "Layer<AgentInvoker> backed by Claude Agent SDK. Constructor takes { logDir, env } per-run.",
		side: "engine",
		group: "service implementations",
		movedFrom: "orchestrator/agent-invoker.ts (factory portion)",
	},
	{
		path: "workflow/agent-hooks.ts",
		role: "SDK hook callbacks for tool-use capture (private to agent-invoker-live)",
		side: "engine",
		group: "service implementations",
		movedFrom: "orchestrator/agent-hooks.ts",
	},
	{
		path: "workflow/run-log-file.ts",
		role: "per-run agent transcript writer (used by agent-hooks)",
		side: "engine",
		group: "service implementations",
		movedFrom: "orchestrator/run-log-file.ts",
	},
	{
		path: "workflow/event-emitter-live.ts",
		role: "Layer<WorkflowEventEmitter> backed by an Effect Queue. Constructor takes Queue<WorkflowEvent>; orchestrator owns dequeue side via event-consumer fiber.",
		side: "engine",
		group: "service implementations",
	},

	// public API — one per workflow.yaml phase (3)
	{
		path: "workflow/resolve-branch.ts",
		role: "resolveBranch — 1× runAgentTurn (or 0 for literal-string branch)",
		side: "engine",
		group: "public API",
	},
	{
		path: "workflow/run-steps.ts",
		role: "runSteps — loop over runAgentTurn (one turn per step)",
		side: "engine",
		group: "public API",
	},
	{
		path: "workflow/render-change-request.ts",
		role: "renderChangeRequest — pure { title; body }, no Effect",
		side: "engine",
		group: "public API",
	},

	// loader pipeline (3)
	{
		path: "workflow/loader.ts",
		role: "loadWorkflow — orchestrates read → parse → validate",
		side: "engine",
		group: "loader pipeline",
	},
	{
		path: "workflow/parser.ts",
		role: "parseRepoWorkflow (YAML → RepoWorkflow)",
		side: "engine",
		group: "loader pipeline",
	},
	{
		path: "workflow/validator.ts",
		role: "validateOutputReferences — one walk, all template surfaces",
		side: "engine",
		group: "loader pipeline",
	},

	// private execution primitives (3)
	{
		path: "workflow/run-agent-turn.ts",
		role: "PRIVATE: the shared one-turn primitive (option D). Used by resolveBranch + runSteps.",
		side: "engine",
		group: "private primitives",
	},
	{
		path: "workflow/render-prompt.ts",
		role: "renderPrompt — prompt template assembler",
		side: "engine",
		group: "private primitives",
	},
	{
		path: "workflow/shell-expansion.ts",
		role: "mark / strip / expand — !`cmd` markdown shell blocks expanded inside rendered prompts",
		side: "engine",
		group: "private primitives",
	},
];

// ── orchestrator/ — post-redesign ─────────────────────────────────────────
export const orchestratorFiles: FileNode[] = [
	{
		path: "orchestrator/orchestrator.ts",
		role: "queue, scheduling, recovery (existing, mostly unchanged)",
		side: "orch",
	},
	{
		path: "orchestrator/run-lifecycle.ts",
		role: "composes engine functions; owns per-run wiring (per-run Queue + perRunLayers + consumerFiber)",
		side: "orch",
	},
	{
		path: "orchestrator/run-repository.ts",
		role: "DB writes for run/step rows (existing)",
		side: "orch",
	},
	{
		path: "orchestrator/workspace.ts",
		role: "clone / checkout / push (existing)",
		side: "orch",
	},
	{
		path: "orchestrator/event-consumer.ts",
		role: "NEW: fiber draining WorkflowEvent queue → runRepo / ctx.emit / canonicalLog / OTel spans / measure_diff. Absorbs agent-metrics.ts + agent-logging.ts.",
		side: "orch",
	},
	{
		path: "orchestrator/parse-shortstat.ts",
		role: "git diff --shortstat parser (existing, used by event-consumer for measure_diff)",
		side: "orch",
	},
	{
		path: "orchestrator/clock.ts",
		role: "existing",
		side: "orch",
	},
	{
		path: "orchestrator/agent-env.ts",
		role: "env builder (existing). Stays in orchestrator/ — it's about *what env* a run uses, not agent invocation itself.",
		side: "orch",
	},

	// Moves OUT to workflow/ (content preserved, just relocated)
	{
		path: "orchestrator/agent-invoker.ts",
		role: "interface → workflow/agent-invoker.ts (Tag); factory → workflow/agent-invoker-live.ts",
		side: "moved",
		movedTo: "workflow/agent-invoker.ts + workflow/agent-invoker-live.ts",
	},
	{
		path: "orchestrator/agent-hooks.ts",
		role: "SDK hook callbacks — relocated, same content",
		side: "moved",
		movedTo: "workflow/agent-hooks.ts",
	},
	{
		path: "orchestrator/run-log-file.ts",
		role: "per-run transcript writer — relocated, same content",
		side: "moved",
		movedTo: "workflow/run-log-file.ts",
	},

	// Deletes (content removed; logic absorbed elsewhere)
	{
		path: "orchestrator/step-runner.ts",
		role: "logic → workflow/run-steps.ts + workflow/run-agent-turn.ts",
		side: "deleted",
	},
	{
		path: "orchestrator/branch-resolver.ts",
		role: "logic → workflow/resolve-branch.ts + workflow/run-agent-turn.ts",
		side: "deleted",
	},
	{
		path: "orchestrator/change-request-renderer.ts",
		role: "logic → workflow/render-change-request.ts",
		side: "deleted",
	},
	{
		path: "orchestrator/agent-logging.ts",
		role: "bridge no longer needed; engine emits WorkflowEvent directly. Folded into event-consumer.ts.",
		side: "deleted",
	},
	{
		path: "orchestrator/agent-metrics.ts",
		role: "folds into event-consumer.ts",
		side: "deleted",
	},
];

export type PublicFn = {
	name: string;
	file: string;
	signature: string;
	purity: "pure" | "effect";
	requires: string[];
};

export const publicFns: PublicFn[] = [
	{
		name: "loadWorkflow",
		file: "workflow/loader.ts",
		signature:
			"(path?: string) => Effect<RepoWorkflow, WorkflowDefinitionError, FileSystem>",
		purity: "effect",
		requires: ["FileSystem"],
	},
	{
		name: "resolveBranch",
		file: "workflow/resolve-branch.ts",
		signature:
			"(workflowBranch: WorkflowBranch, scope: PromptScope)\n  => Effect<string, WorkflowExecutionError, AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem>",
		purity: "effect",
		requires: [
			"AgentInvoker",
			"WorkflowEventEmitter",
			"CommandExecutor",
			"FileSystem",
		],
	},
	{
		name: "runSteps",
		file: "workflow/run-steps.ts",
		signature:
			"(steps: ReadonlyArray<WorkflowStep>, scope: PromptScope, branch: string, cwd: string, env?: Record<string,string>)\n  => Effect<Record<string, unknown>, WorkflowExecutionError, AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem>",
		purity: "effect",
		requires: [
			"AgentInvoker",
			"WorkflowEventEmitter",
			"CommandExecutor",
			"FileSystem",
		],
	},
	{
		name: "renderChangeRequest",
		file: "workflow/render-change-request.ts",
		signature:
			"(template: ChangeRequestTemplate, scope: PromptScope, branch: string, outputs: Record<string, unknown>)\n  => { title: string; body: string }",
		purity: "pure",
		requires: [],
	},
];

export type ServiceTag = {
	name: string;
	tagKey: string;
	definedIn: string;
	liveLayer: string;
	liveIn: string;
	iface: string;
	notes: string;
	lifetime: "per-run" | "app-wide";
};

export const tags: ServiceTag[] = [
	{
		name: "AgentInvoker",
		tagKey: "workflow/AgentInvoker",
		definedIn: "workflow/agent-invoker.ts",
		liveLayer: "AgentInvokerLive({ logDir, env })",
		liveIn: "workflow/agent-invoker-live.ts",
		iface:
			"interface AgentInvoker {\n  readonly invoke: (opts: AgentInvokeOptions) => AsyncIterable<AgentMessage>\n}",
		lifetime: "per-run",
		notes:
			"PER-RUN. Layer-constructor function exported from workflow/. orchestrator's run-lifecycle.ts constructs it with { logDir, env } and provides it via Effect.provide around each resolveBranch / runSteps call. NOT part of WorkflowLayer.",
	},
	{
		name: "WorkflowEventEmitter",
		tagKey: "workflow/WorkflowEventEmitter",
		definedIn: "workflow/event-emitter.ts",
		liveLayer: "WorkflowEventEmitterLive(eventQueue)",
		liveIn: "workflow/event-emitter-live.ts",
		iface:
			"interface WorkflowEventEmitter {\n  readonly emit: (event: WorkflowEvent) => Effect<void>\n}",
		lifetime: "per-run",
		notes:
			"PER-RUN. Layer-constructor function exported from workflow/. Takes a Queue<WorkflowEvent>; orchestrator owns the dequeue side via its event-consumer fiber. NOT part of WorkflowLayer.",
	},
];

export type WorkflowEvent = {
	tag: string;
	payload: string;
	emittedFrom: string;
	consumedBy: string[];
};

export const events: WorkflowEvent[] = [
	{
		tag: "BranchAssistantMessage",
		payload: "{ message }",
		emittedFrom: "resolveBranch",
		consumedBy: ["ctx.emit (SSE)", "canonical log"],
	},
	{
		tag: "BranchResolved",
		payload: "{ name, usage: StepUsage }",
		emittedFrom: "resolveBranch",
		consumedBy: ["runRepo.branch", "metrics (per-model)", "log"],
	},
	{
		tag: "BranchFailed",
		payload: "{ error: WorkflowExecutionError, usage: StepUsage }",
		emittedFrom: "resolveBranch",
		consumedBy: ["runRepo.error", "metrics (per-model)", "log"],
	},
	{
		tag: "StepStarted",
		payload: "{ name, index, total }",
		emittedFrom: "runSteps",
		consumedBy: ["runRepo.stepRow", "ctx.emit", "telemetry span"],
	},
	{
		tag: "StepAssistantMessage",
		payload: "{ stepName, message }",
		emittedFrom: "runSteps",
		consumedBy: ["ctx.emit", "log"],
	},
	{
		tag: "StepToolFailure",
		payload: "{ stepName, toolName }",
		emittedFrom: "runSteps",
		consumedBy: ["log", "metrics"],
	},
	{
		tag: "StepResult",
		payload: "{ stepName, structuredOutput?, sessionId, usage: StepUsage }",
		emittedFrom: "runSteps",
		consumedBy: ["runRepo.stepRow", "log", "metrics (per-model)"],
	},
	{
		tag: "StepCompleted",
		payload: "{ stepName, index, durationMs }",
		emittedFrom: "runSteps",
		consumedBy: ["runRepo", "telemetry", "measure_diff"],
	},
	{
		tag: "StepFailed",
		payload: "{ stepName, index, error: WorkflowExecutionError, durationMs }",
		emittedFrom: "runSteps",
		consumedBy: ["runRepo", "telemetry", "log"],
	},
];

export type LifecycleStep = {
	label: string;
	side: "orch" | "engine";
	detail?: string;
};

export const lifecycle: LifecycleStep[] = [
	{ label: "clone repo", side: "orch", detail: "workspace.ts" },
	{
		label: "resolveBranch",
		side: "engine",
		detail: "1× runAgentTurn (or 0 if literal)",
	},
	{ label: "checkout", side: "orch", detail: "workspace.ts" },
	{ label: "repo bootstrap", side: "orch", detail: ".agent/setup.sh" },
	{
		label: "runSteps",
		side: "engine",
		detail: "loop: runAgentTurn per step",
	},
	{ label: "push --force", side: "orch", detail: "workspace.ts" },
	{
		label: "renderChangeRequest",
		side: "engine",
		detail: "pure — no Effect",
	},
	{
		label: "codeHost.createChangeRequest",
		side: "orch",
		detail: "codeHost adapter",
	},
	{
		label: "tracker.transition",
		side: "orch",
		detail: "running → awaiting_review",
	},
];

export const promptScopeShape = `// workflow/types.ts

type PromptIssue = {
  key: IssueKey;
  number: IssueNumber;
  title: string;
  description: string;
  labels: readonly string[];
  url: string;
  createdAt: string;
};
// note: tracker Issue.repo is dropped — not in template surface

type PromptScope = {
  issue: PromptIssue;
  baseBranch: string;
};

type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
};

type StepUsage = {
  costUsd: number;
  tokensInput: number;
  tokensOutput: number;
  modelUsage: Record<string, ModelUsage>;
};`;

// First-class template surfaces. The validator walks all three with one
// generalised algorithm — only the scope set differs per site.
export type TemplateSurface = {
	label: string;
	site: string;
	scope: string;
	errorLabel: string;
	role: "branch" | "step" | "change_request";
};

export const templateSurfaces: TemplateSurface[] = [
	{
		label: "branch phase",
		site: "branch.agent.prompt",
		scope: "{}",
		errorLabel: '"branch.agent.prompt"',
		role: "branch",
	},
	{
		label: "step phase (each)",
		site: "steps[N].prompt",
		scope: "steps[0..N-1].output",
		errorLabel: "step.name (only site with a name)",
		role: "step",
	},
	{
		label: "change_request phase",
		site: "change_request.title",
		scope: "all steps",
		errorLabel: '"change_request.title"',
		role: "change_request",
	},
	{
		label: "change_request phase",
		site: "change_request.body",
		scope: "all steps",
		errorLabel: '"change_request.body"',
		role: "change_request",
	},
];

export const errorsCode = `// workflow/errors.ts — 5 tagged errors + 3 unions

export class WorkflowParseError          extends Data.TaggedError("WorkflowParseError")<{ message: string }> {}
export class WorkflowValidationError     extends Data.TaggedError("WorkflowValidationError")<{ message: string }> {}
export class ShellExpansionError         extends Data.TaggedError("ShellExpansionError")<{ message: string }> {}
export class AgentTurnError              extends Data.TaggedError("AgentTurnError")<{ message: string; subtype?: string }> {}
export class StructuredOutputDecodeError extends Data.TaggedError("StructuredOutputDecodeError")<{ message: string; context: "step" | "branch" }> {}

export type WorkflowDefinitionError = WorkflowParseError | WorkflowValidationError;
export type WorkflowExecutionError  = ShellExpansionError | AgentTurnError | StructuredOutputDecodeError;
export type WorkflowError           = WorkflowDefinitionError | WorkflowExecutionError;`;

export const runAgentTurnSignature = `// workflow/run-agent-turn.ts — PRIVATE (not exported from module index)

runAgentTurn: (input: {
  prompt: string;
  model: ModelId;
  outputSchema: JsonSchemaDocument;     // required — both callers always have one
  allowedTools?: readonly string[];
  resumeSessionId?: string;
  shellExpansion?: { cwd: string; env: Record<string, string> };   // opt-in
  emitAs:
    | { kind: "branch" }
    | { kind: "step"; name: string; index: number; total: number };
}) => Effect<{
  structuredOutput: unknown;
  sessionId: string;
  usage: {
    costUsd: number;
    tokensInput: number;
    tokensOutput: number;
    modelUsage: Record<string, ModelUsage>;
  };
}, WorkflowExecutionError, AgentInvoker | WorkflowEventEmitter | CommandExecutor | FileSystem>`;

export const runtimeScaffoldingNote =
	"MIGRATION SCAFFOLDING — keep WorkflowLayer + makeWorkflowRuntime until a single app-wide ManagedRuntime in server.ts merges WorkflowLayer ⊕ TrackerLayer ⊕ CodeHostLayer ⊕ … Then delete. WorkflowLayer provides ONLY NodeFileSystem + NodeCommandExecutor + Logger.pretty — never AgentInvoker or WorkflowEventEmitter (those are per-run).";

export const perRunWiringSketch = `// orchestrator/run-lifecycle.ts — the key payoff

const eventQueue    = yield* Queue.unbounded<WorkflowEvent>();
const consumerFiber = yield* Effect.fork(consumeEvents(eventQueue, ...));

const perRunLayers = Layer.mergeAll(
  AgentInvokerLive({ logDir, env }),       // from workflow/agent-invoker-live.ts
  WorkflowEventEmitterLive(eventQueue),    // from workflow/event-emitter-live.ts
);

yield* Effect.all([
  engine.resolveBranch(workflow.branch, scope),
  // ... checkout, bootstrap ...
  engine.runSteps(workflow.steps, scope, branch, cwd),
  // ... push ...
]).pipe(Effect.provide(perRunLayers));`;
