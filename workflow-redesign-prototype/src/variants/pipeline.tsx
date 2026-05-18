// Variant: Pipeline lanes — left→right run-lifecycle as a swimlane diagram.
// Emphasises: who-owns-which-step, where the engine borders are, where events fire,
// and the "branch / steps / change_request are sibling phases" framing.
import {
	events,
	lifecycle,
	perRunWiringSketch,
	publicFns,
	templateSurfaces,
} from "../data.ts";
import { CodeBlock } from "./shared.tsx";

export function PipelineVariant() {
	return (
		<>
			<div className="panel">
				<div className="h">
					Run lifecycle — orchestrator caller (post-redesign)
				</div>
				<div className="pipeline-grid">
					<div className="lane-row">
						<div className="lane-label">orchestrator/</div>
						<div className="pipe">
							{lifecycle.map((s, i) => (
								<LaneCell
									key={s.label}
									step={s}
									visible={s.side === "orch"}
									last={i === lifecycle.length - 1}
								/>
							))}
						</div>
					</div>
					<div className="lane-row">
						<div className="lane-label">workflow/ (engine)</div>
						<div className="pipe">
							{lifecycle.map((s, i) => (
								<LaneCell
									key={s.label}
									step={s}
									visible={s.side === "engine"}
									last={i === lifecycle.length - 1}
								/>
							))}
						</div>
					</div>
				</div>
				<div className="sub" style={{ marginTop: 10 }}>
					Engine owns 3 of 9 arrows. Inside the engine, both{" "}
					<code>resolveBranch</code> and <code>runSteps</code> are built on a
					single private primitive — <code>runAgentTurn</code>.{" "}
					<code>resolveBranch</code> calls it once (or zero times for a literal
					branch string); <code>runSteps</code> loops it per step.
				</div>
			</div>

			<div className="panel">
				<div className="h">Per-run wiring — orchestrator/run-lifecycle.ts</div>
				<div className="sub" style={{ marginBottom: 8 }}>
					orchestrator's only DI job: create the per-run Queue, fork the
					event-consumer fiber, build <code>perRunLayers</code> from the live
					layers exported by <code>workflow/</code>, and provide them around the
					engine calls.
				</div>
				<CodeBlock code={perRunWiringSketch} />
			</div>

			<div className="panel">
				<div className="h">
					Template surfaces — branch / steps / change_request are sibling phases
				</div>
				<div className="sub" style={{ marginBottom: 10 }}>
					The validator walks every template string with one generalised
					algorithm — only the <code>allowedSteps</code> scope differs per site.
					Forward-reference detection in step prompts is just one case of the
					general rule.
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
			</div>

			<div className="panel">
				<div className="h">Engine public surface (in call order)</div>
				{publicFns.map((fn) => (
					<div key={fn.name} style={{ marginBottom: 12 }}>
						<div>
							<span className="mono" style={{ color: "var(--accent)" }}>
								{fn.name}
							</span>
							<span className="tag engine">{fn.file}</span>
							{fn.purity === "pure" && <span className="tag">pure</span>}
							{fn.requires.length > 0 && (
								<span className="tag shared">
									R = {fn.requires.join(" | ")}
								</span>
							)}
						</div>
						<CodeBlock code={fn.signature} />
					</div>
				))}
			</div>

			<div className="panel">
				<div className="h">WorkflowEvent — what fires & who reacts</div>
				<div className="sub" style={{ marginBottom: 8 }}>
					<code>BranchResolved</code>, <code>BranchFailed</code> and{" "}
					<code>StepResult</code> all carry <code>usage: StepUsage</code> with a
					per-model breakdown — orchestrator's metrics consumer writes one row
					per model.
				</div>
				<div className="event-list">
					{events.map((e) => (
						<div className="ev" key={e.tag}>
							{e.tag} <span className="src">{e.payload}</span>
							<div className="src" style={{ marginTop: 2 }}>
								from {e.emittedFrom} → {e.consumedBy.join(", ")}
							</div>
						</div>
					))}
				</div>
			</div>
		</>
	);
}

function LaneCell({
	step,
	visible,
	last,
}: {
	step: { label: string; side: string; detail?: string };
	visible: boolean;
	last: boolean;
}) {
	return (
		<>
			<div
				className={`node ${step.side}`}
				style={{ opacity: visible ? 1 : 0.08 }}
			>
				<div className="name">{step.label}</div>
				<div className="meta">{step.detail}</div>
			</div>
			{!last && <div className="arr">→</div>}
		</>
	);
}
