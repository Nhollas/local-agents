// Variant: Services-in-middle — two Tags as the bus between engine and orchestrator.
// Emphasises: DI wiring, where Tag/Live live (BOTH in workflow/),
// and the per-run vs app-wide layer distinction.
import {
	events,
	perRunWiringSketch,
	publicFns,
	runAgentTurnSignature,
	runtimeScaffoldingNote,
	tags,
} from "../data.ts";
import { CodeBlock } from "./shared.tsx";

export function ServicesVariant() {
	return (
		<>
			<div className="constellation">
				<div className="side">
					<div className="panel">
						<div className="h">workflow/ (engine) — consumers</div>
						{publicFns
							.filter((f) => f.requires.length > 0)
							.map((fn) => (
								<div key={fn.name} style={{ marginBottom: 10 }}>
									<div className="mono" style={{ color: "var(--engine)" }}>
										{fn.name}
									</div>
									<div className="sub mono">
										requires: {fn.requires.join(", ")}
									</div>
								</div>
							))}
						<div className="sub" style={{ marginTop: 10, fontStyle: "italic" }}>
							Plus pure: <code>renderChangeRequest</code> (no R)
							<br />
							Plus FS-only: <code>loadWorkflow</code>
						</div>
					</div>
					<div className="panel">
						<div className="h">private internal — runAgentTurn</div>
						<div className="sub" style={{ marginBottom: 8 }}>
							The one-turn primitive. <code>resolveBranch</code> calls it once
							(or 0× for literal-string branch). <code>runSteps</code> loops it.
							Both calls always have an <code>outputSchema</code>, so it's
							required.
						</div>
						<CodeBlock code={runAgentTurnSignature} />
					</div>
				</div>

				<div className="center-services">
					<div className="h" style={{ color: "var(--accent)" }}>
						Context.Tag — DI bus (per-run)
					</div>
					<div className="sub" style={{ marginBottom: 10 }}>
						Tag, interface AND live layer all live in <code>workflow/</code>.
						orchestrator only constructs per-run and provides.
					</div>
					{tags.map((t) => (
						<div className="svc" key={t.name}>
							<div className="svc-name">
								{t.name}{" "}
								<span className="tag tbd" style={{ marginLeft: 6 }}>
									{t.lifetime}
								</span>
							</div>
							<div className="key mono">"{t.tagKey}"</div>
							<div className="iface mono">
								<CodeBlock code={t.iface} />
							</div>
							<div className="connector" style={{ marginTop: 8 }}>
								← engine yields <code>{t.name}</code> & uses{" "}
								<code>
									{t.name === "AgentInvoker" ? "invoke(opts)" : "emit(event)"}
								</code>
							</div>
							<div className="connector">
								→ live layer <code>{t.liveLayer}</code> exported from{" "}
								<code>{t.liveIn}</code>
							</div>
							<div className="connector">
								→ orchestrator <code>Effect.provide(...)</code>s it per-run
							</div>
						</div>
					))}
				</div>

				<div className="side">
					<div className="panel">
						<div className="h">
							workflow/ — live layer constructors (per-run config)
						</div>
						{tags.map((t) => (
							<div key={t.name} style={{ marginBottom: 10 }}>
								<div className="mono" style={{ color: "var(--engine)" }}>
									{t.liveLayer}
								</div>
								<div className="sub mono">{t.liveIn}</div>
								<div className="sub">{t.notes}</div>
							</div>
						))}
					</div>
					<div className="panel">
						<div className="h">orchestrator/ — caller & event consumer</div>
						<div className="sub" style={{ marginBottom: 8 }}>
							<code>orchestrator/run-lifecycle.ts</code> creates the per-run
							Queue, forks <code>event-consumer.ts</code>, builds{" "}
							<code>perRunLayers</code> from the workflow/ live layers, and
							provides them.
						</div>
						<div className="h" style={{ marginTop: 10 }}>
							event-consumer.ts fans WorkflowEvent out to:
						</div>
						<ul
							className="sub mono"
							style={{
								paddingLeft: 16,
								margin: 0,
								listStyle: "square",
							}}
						>
							<li>runRepo (DB rows incl. per-model usage)</li>
							<li>ctx.emit (SSE → dashboard)</li>
							<li>canonical log file</li>
							<li>telemetry spans (OTel)</li>
							<li>measure_diff (uses parse-shortstat.ts)</li>
						</ul>
						<div className="sub" style={{ marginTop: 8, fontStyle: "italic" }}>
							Absorbs today's agent-metrics.ts + agent-logging.ts.
						</div>
					</div>
				</div>
			</div>

			<div className="panel" style={{ marginTop: 16 }}>
				<div className="h">
					Layer lifetimes — app-wide vs per-run{" "}
					<span className="tag tbd">migration scaffolding</span>
				</div>
				<div className="sub" style={{ marginBottom: 8 }}>
					{runtimeScaffoldingNote}
				</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: 12,
					}}
				>
					<div className="panel" style={{ background: "var(--panel-2)" }}>
						<div className="h">app-wide (boot once)</div>
						<div className="mono" style={{ color: "var(--engine)" }}>
							WorkflowLayer
						</div>
						<div className="sub">
							NodeFileSystem ⊕ NodeCommandExecutor ⊕ Logger.pretty
						</div>
						<div className="sub" style={{ marginTop: 4 }}>
							Does NOT include AgentInvoker or WorkflowEventEmitter.
						</div>
						<div
							className="mono"
							style={{ marginTop: 6, color: "var(--engine)" }}
						>
							makeWorkflowRuntime()
						</div>
						<div className="sub">
							End state: one ManagedRuntime in <code>server.ts</code> merging
							WorkflowLayer ⊕ TrackerLayer ⊕ CodeHostLayer ⊕ …
						</div>
					</div>
					<div className="panel" style={{ background: "var(--panel-2)" }}>
						<div className="h">per-run (constructed each run)</div>
						<div className="mono" style={{ color: "var(--engine)" }}>
							AgentInvokerLive({"{ logDir, env }"})
						</div>
						<div className="sub">
							from <code>workflow/agent-invoker-live.ts</code> — bakes run-log
							dir + agent env
						</div>
						<div
							className="mono"
							style={{ marginTop: 6, color: "var(--engine)" }}
						>
							WorkflowEventEmitterLive(eventQueue)
						</div>
						<div className="sub">
							from <code>workflow/event-emitter-live.ts</code> — takes the
							Queue; orchestrator owns dequeue via event-consumer fiber
						</div>
					</div>
				</div>
			</div>

			<div className="panel">
				<div className="h">Wiring sketch — orchestrator builds & provides</div>
				<CodeBlock code={perRunWiringSketch} />
			</div>

			<div className="panel">
				<div className="h">WorkflowEvent flow</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr 1fr",
						gap: 10,
					}}
				>
					<div>
						<div className="sub" style={{ marginBottom: 6 }}>
							emitted from <code>resolveBranch</code>
						</div>
						{events
							.filter((e) => e.emittedFrom === "resolveBranch")
							.map((e) => (
								<div className="ev" key={e.tag} style={{ marginBottom: 4 }}>
									{e.tag}
								</div>
							))}
					</div>
					<div>
						<div className="sub" style={{ marginBottom: 6 }}>
							emitted from <code>runSteps</code>
						</div>
						{events
							.filter((e) => e.emittedFrom === "runSteps")
							.map((e) => (
								<div className="ev" key={e.tag} style={{ marginBottom: 4 }}>
									{e.tag}
								</div>
							))}
					</div>
					<div>
						<div className="sub" style={{ marginBottom: 6 }}>
							all drained by
						</div>
						<div className="mono sub">
							event-consumer.ts
							<br />⇣ Match.tag(...).pipe(...)
							<br />⇣ runRepo / ctx.emit / canonicalLog / OTel / measure_diff
							<br />⇣ per-model usage rows from StepUsage.modelUsage
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
