// Variant: Code-first browser — clickable file tree, signature drill-down.
// Emphasises: exact code shape, file-by-file detail. The most "IDE-like" view.
import { useState } from "react";
import {
	errorsCode,
	events,
	type FileNode,
	orchestratorFiles,
	perRunWiringSketch,
	promptScopeShape,
	publicFns,
	runAgentTurnSignature,
	runtimeScaffoldingNote,
	tags,
	templateSurfaces,
	workflowFiles,
} from "../data.ts";
import { CodeBlock } from "./shared.tsx";

const WORKFLOW_GROUP_ORDER = [
	"data shape",
	"service contracts",
	"service implementations",
	"public API",
	"loader pipeline",
	"private primitives",
] as const;

export function CodeFirstVariant() {
	const all: FileNode[] = [...workflowFiles, ...orchestratorFiles];
	const [active, setActive] = useState<string>("workflow/run-agent-turn.ts");
	const node = all.find((f) => f.path === active) ?? all[0];

	// group orchestrator into 3 buckets so moves vs deletes vs kept are visually distinct
	const orchKept = orchestratorFiles.filter((f) => f.side === "orch");
	const orchMoved = orchestratorFiles.filter((f) => f.side === "moved");
	const orchDeleted = orchestratorFiles.filter((f) => f.side === "deleted");

	return (
		<div className="code-grid">
			<div className="fs-tree">
				<div className="h">server/ — target tree</div>
				<div className="mono" style={{ color: "var(--accent-2)" }}>
					workflow/ <span className="sub">· 18 files, flat</span>
				</div>
				{WORKFLOW_GROUP_ORDER.map((group) => {
					const files = workflowFiles.filter((f) => f.group === group);
					if (files.length === 0) return null;
					return (
						<div key={group} style={{ marginTop: 4 }}>
							<div
								className="sub"
								style={{
									paddingLeft: 10,
									fontSize: 10.5,
									textTransform: "uppercase",
									letterSpacing: "0.06em",
									marginTop: 4,
								}}
							>
								{group}
								<span className="sub" style={{ marginLeft: 6 }}>
									({files.length})
								</span>
							</div>
							<ul>
								{files.map((f) => (
									<TreeLi
										key={f.path}
										file={f}
										active={active === f.path}
										onPick={setActive}
									/>
								))}
							</ul>
						</div>
					);
				})}
				<div
					className="mono"
					style={{ color: "var(--accent-2)", marginTop: 10 }}
				>
					orchestrator/
				</div>
				<div
					className="sub"
					style={{
						paddingLeft: 10,
						fontSize: 10.5,
						textTransform: "uppercase",
						letterSpacing: "0.06em",
						marginTop: 4,
					}}
				>
					kept
				</div>
				<ul>
					{orchKept.map((f) => (
						<TreeLi
							key={f.path}
							file={f}
							active={active === f.path}
							onPick={setActive}
						/>
					))}
				</ul>
				<div
					className="sub"
					style={{
						paddingLeft: 10,
						fontSize: 10.5,
						textTransform: "uppercase",
						letterSpacing: "0.06em",
						marginTop: 4,
						color: "var(--accent)",
					}}
				>
					moved → workflow/
				</div>
				<ul>
					{orchMoved.map((f) => (
						<TreeLi
							key={f.path}
							file={f}
							active={active === f.path}
							onPick={setActive}
						/>
					))}
				</ul>
				<div
					className="sub"
					style={{
						paddingLeft: 10,
						fontSize: 10.5,
						textTransform: "uppercase",
						letterSpacing: "0.06em",
						marginTop: 4,
						color: "var(--danger)",
					}}
				>
					deleted
				</div>
				<ul>
					{orchDeleted.map((f) => (
						<TreeLi
							key={f.path}
							file={f}
							active={active === f.path}
							onPick={setActive}
						/>
					))}
				</ul>
				<div className="sub" style={{ marginTop: 10, fontSize: 10.5 }}>
					Click any file. <span style={{ color: "var(--danger)" }}>delete</span>{" "}
					= strikethrough, <span style={{ color: "var(--accent)" }}>move</span>{" "}
					= → with destination.
				</div>
			</div>

			<div className="code-pane">
				<Detail node={node} />
			</div>
		</div>
	);
}

function TreeLi({
	file,
	active,
	onPick,
}: {
	file: FileNode;
	active: boolean;
	onPick: (p: string) => void;
}) {
	const cls = [
		"file",
		active && "active",
		file.side === "deleted" && "deleted",
		file.side === "moved" && "moved",
		file.note && "tbd",
	]
		.filter(Boolean)
		.join(" ");
	const short = file.path.split("/").slice(1).join("/");
	return (
		<li className={cls} onClick={() => onPick(file.path)}>
			{short}
			{file.side === "moved" && (
				<span className="tag moved" style={{ marginLeft: 6 }}>
					→ workflow/
				</span>
			)}
			{file.movedFrom && (
				<span className="tag moved" style={{ marginLeft: 6 }}>
					moved in
				</span>
			)}
			{file.note && <span className="tag tbd">scaffolding</span>}
		</li>
	);
}

function Detail({ node }: { node: FileNode }) {
	const fn = publicFns.find((f) => f.file === node.path);
	const tag = tags.find((t) => t.definedIn === node.path);

	if (node.side === "deleted") {
		return (
			<>
				<h2>
					{node.path} <span className="tag danger">DELETED</span>
				</h2>
				<div className="file-meta" style={{ textDecoration: "line-through" }}>
					{node.role}
				</div>
				<div className="sub">
					Responsibility has moved (see role above). The engine now emits{" "}
					<code>WorkflowEvent</code> directly, so SDK→ctx bridging / metrics
					collection collapse into <code>orchestrator/event-consumer.ts</code>.
				</div>
			</>
		);
	}

	if (node.side === "moved") {
		return (
			<>
				<h2>
					{node.path} <span className="tag moved">MOVED → {node.movedTo}</span>
				</h2>
				<div className="file-meta">{node.role}</div>
				<div className="sub" style={{ marginTop: 8 }}>
					Content is preserved — this file is just relocated. All
					agent-invocation code lives in <code>workflow/</code> now;
					orchestrator only constructs the per-run Layer (with{" "}
					<code>{`{ logDir, env }`}</code>) and provides it via{" "}
					<code>Effect.provide</code> around <code>resolveBranch</code> /{" "}
					<code>runSteps</code>.
				</div>
			</>
		);
	}

	return (
		<>
			<h2>
				{node.path} <span className={`tag ${node.side}`}>{node.side}</span>
				{node.movedFrom && (
					<span className="tag moved">moved from {node.movedFrom}</span>
				)}
				{node.note && <span className="tag tbd">scaffolding</span>}
			</h2>
			<div className="file-meta">{node.role}</div>
			{node.note && (
				<div className="sub" style={{ color: "var(--tbd)" }}>
					{node.note}
				</div>
			)}

			{fn && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Public signature
					</div>
					<CodeBlock code={`${fn.name}: ${fn.signature}`} />
					{fn.requires.length > 0 && (
						<div className="sub">
							Requires (R channel): <code>{fn.requires.join(" | ")}</code>
						</div>
					)}
					{fn.purity === "pure" && (
						<div className="sub">
							Pure — no Effect, no DI. Call it directly.
						</div>
					)}
				</>
			)}

			{tag && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Tag interface <span className="tag tbd">{tag.lifetime}</span>
					</div>
					<CodeBlock code={tag.iface} />
					<div className="sub">
						key: <code>"{tag.tagKey}"</code> · live in <code>{tag.liveIn}</code>
					</div>
					<div className="sub" style={{ marginTop: 6 }}>
						{tag.notes}
					</div>
				</>
			)}

			{node.path === "workflow/types.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						PromptScope + StepUsage
					</div>
					<CodeBlock code={promptScopeShape} />
				</>
			)}

			{node.path === "workflow/errors.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Errors — 5 tagged errors + 3 unions
					</div>
					<CodeBlock code={errorsCode} />
					<div className="sub" style={{ marginTop: 6 }}>
						<code>StructuredOutputDecodeError</code> carries a{" "}
						<code>context: "step" | "branch"</code> discriminator — one tag, not
						two. <code>renderChangeRequest</code> is pure and has no error
						channel.
					</div>
				</>
			)}

			{node.path === "workflow/validator.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Template surfaces — one generalised walk
					</div>
					<div className="sub" style={{ marginBottom: 8 }}>
						Branch and change_request are "first-class citizen phases" of the
						workflow, conceptually sibling to steps. Same algorithm, four
						scopes; forward-reference detection in step prompts is just a
						special case.
					</div>
					<div className="phase-grid">
						{templateSurfaces.map((s) => (
							<div key={s.site} className={`phase phase-${s.role}`}>
								<div className="phase-label">{s.label}</div>
								<div className="mono phase-site">{s.site}</div>
								<div className="sub">
									scope: <code>{s.scope}</code>
								</div>
								<div className="sub">
									error label: <code>{s.errorLabel}</code>
								</div>
							</div>
						))}
					</div>
				</>
			)}

			{node.path === "workflow/runtime.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Exports
					</div>
					<CodeBlock
						code={`// MIGRATION SCAFFOLDING
export const WorkflowLayer = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeCommandExecutor.layer,
  Logger.pretty,
)
// WorkflowLayer does NOT include AgentInvoker or
// WorkflowEventEmitter — those are per-run, constructed
// in orchestrator/run-lifecycle.ts.

export const makeWorkflowRuntime = () =>
  ManagedRuntime.make(WorkflowLayer)`}
					/>
					<div className="sub" style={{ color: "var(--tbd)" }}>
						{runtimeScaffoldingNote}
					</div>
				</>
			)}

			{node.path === "workflow/event-emitter.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						WorkflowEvent variants
					</div>
					<CodeBlock
						code={
							"type ModelUsage = { inputTokens: number; outputTokens: number; costUSD: number }\n" +
							"type StepUsage = {\n" +
							"  costUsd: number\n" +
							"  tokensInput: number\n" +
							"  tokensOutput: number\n" +
							"  modelUsage: Record<string, ModelUsage>\n" +
							"}\n\n" +
							"type WorkflowEvent = Data.TaggedEnum<{\n" +
							events.map((e) => `  ${e.tag}: ${e.payload}`).join("\n") +
							"\n}>"
						}
					/>
					<div className="h" style={{ marginTop: 14 }}>
						Emit → consume
					</div>
					{events.map((e) => (
						<div className="sub" key={e.tag} style={{ marginBottom: 2 }}>
							<code style={{ color: "var(--event)" }}>{e.tag}</code> from{" "}
							<code>{e.emittedFrom}</code> → {e.consumedBy.join(", ")}
						</div>
					))}
				</>
			)}

			{node.path === "workflow/agent-invoker-live.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Layer constructor (per-run)
					</div>
					<CodeBlock
						code={`// Layer-constructor function exported from workflow/.
// orchestrator's run-lifecycle.ts calls it per run.
export const AgentInvokerLive = (cfg: { logDir: string; env: Record<string, string> }) =>
  Layer.scoped(
    AgentInvoker,
    Effect.gen(function* () {
      const transcript = yield* makeRunLogFile(cfg.logDir)
      const hooks      = makeAgentHooks(transcript)
      return AgentInvoker.of({
        invoke: (opts) => sdk.query({ ...opts, env: cfg.env, hooks }),
      })
    }),
  )`}
					/>
					<div className="sub">
						Wraps the Claude Agent SDK. Uses{" "}
						<code>workflow/agent-hooks.ts</code> (private) for tool-use capture
						and <code>workflow/run-log-file.ts</code> for the per-run
						transcript.
					</div>
				</>
			)}

			{node.path === "workflow/event-emitter-live.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Layer constructor (per-run)
					</div>
					<CodeBlock
						code={`// Layer-constructor function exported from workflow/.
// Constructor takes a Queue<WorkflowEvent>; orchestrator
// owns the dequeue side via its event-consumer fiber.
export const WorkflowEventEmitterLive = (queue: Queue.Queue<WorkflowEvent>) =>
  Layer.succeed(
    WorkflowEventEmitter,
    WorkflowEventEmitter.of({
      emit: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
    }),
  )`}
					/>
				</>
			)}

			{node.path === "workflow/agent-hooks.ts" && (
				<div className="sub" style={{ marginTop: 10 }}>
					Private to <code>agent-invoker-live.ts</code>. SDK hook callbacks for
					tool-use capture. Moved from orchestrator/ — content unchanged.
				</div>
			)}

			{node.path === "workflow/run-log-file.ts" && (
				<div className="sub" style={{ marginTop: 10 }}>
					Per-run agent transcript writer, used by <code>agent-hooks.ts</code>.
					Moved from orchestrator/ — content unchanged.
				</div>
			)}

			{node.path === "workflow/run-agent-turn.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Signature (LOCKED)
					</div>
					<CodeBlock code={runAgentTurnSignature} />
					<div className="sub" style={{ marginTop: 6 }}>
						Both <code>resolveBranch</code> and <code>runSteps</code> build on
						this. The literal-string branch case short-circuits before reaching
						it: <code>Effect.succeed(renderPrompt(branch, scope))</code>.{" "}
						<code>outputSchema</code> is required — both callers always have
						one.
					</div>
				</>
			)}

			{node.path === "workflow/resolve-branch.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Sketch
					</div>
					<CodeBlock
						code={`export const resolveBranch = (wb: WorkflowBranch, scope: PromptScope) =>
  typeof wb === "string"
    ? Effect.succeed(renderPrompt(wb, scope))           // literal — 0 agent turns
    : runAgentTurn({
        prompt: renderPrompt(wb.prompt, scope),
        model: wb.model,
        outputSchema: wb.schema,                        // { name: string }
        emitAs: { kind: "branch" },
      }).pipe(
        Effect.flatMap(r => decodeBranchOutput(r.structuredOutput)),
        Effect.mapError(e => new StructuredOutputDecodeError({
          message: e.message,
          context: "branch",
        })),
      )`}
					/>
				</>
			)}

			{node.path === "workflow/run-steps.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Sketch
					</div>
					<CodeBlock
						code={`export const runSteps = (steps, scope, branch, cwd, env = {}) =>
  Effect.gen(function* () {
    const outputs: Record<string, unknown> = {}
    let previousSessionId: string | undefined
    for (const [i, step] of steps.entries()) {
      const r = yield* runAgentTurn({
        prompt: renderPrompt(step.prompt, { ...scope, branch, steps: outputs }),
        model: step.model,
        outputSchema: step.output_schema ?? PASSTHROUGH_SCHEMA,
        allowedTools: step.allowed_tools,
        resumeSessionId: step.resume_previous ? previousSessionId : undefined,
        shellExpansion: { cwd, env },                  // always available for steps
        emitAs: { kind: "step", name: step.name, index: i + 1, total: steps.length },
      })
      if (step.output_schema) outputs[step.name] = r.structuredOutput
      previousSessionId = r.sessionId
    }
    return outputs
  })`}
					/>
				</>
			)}

			{node.path === "orchestrator/run-lifecycle.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						Per-run wiring — the key payoff
					</div>
					<CodeBlock code={perRunWiringSketch} />
					<div className="sub" style={{ marginTop: 8 }}>
						<code>AgentInvokerLive</code> and{" "}
						<code>WorkflowEventEmitterLive</code> are{" "}
						<b>layer-constructor functions exported from workflow/</b>, taking
						per-run config as arguments. They are NOT part of{" "}
						<code>WorkflowLayer</code> (which is boot-time only).
					</div>
				</>
			)}

			{node.path === "orchestrator/event-consumer.ts" && (
				<>
					<div className="h" style={{ marginTop: 14 }}>
						What it does
					</div>
					<div className="sub" style={{ marginBottom: 8 }}>
						Drains the per-run WorkflowEvent queue and fans events out by tag.
						Absorbs today's <code>agent-metrics.ts</code> and{" "}
						<code>agent-logging.ts</code>. Writes per-model usage rows to
						canonicalLog from <code>StepUsage.modelUsage</code> — aggregate
						alone wasn't enough.
					</div>
					<CodeBlock
						code={`Match.type<WorkflowEvent>().pipe(
  Match.tag("StepStarted", e => runRepo.upsertStep(e) <* ctx.emit(e) <* otel.start(e)),
  Match.tag("StepResult",  e => runRepo.writeOutput(e) <* writePerModelUsage(e.usage)),
  Match.tag("StepCompleted", e => measureDiff(cwd).flatMap(d => runRepo.completeStep(e, d))),
  Match.tag("BranchResolved", e => writePerModelUsage(e.usage)),
  // ...
  Match.exhaustive,
)`}
					/>
				</>
			)}
		</>
	);
}
