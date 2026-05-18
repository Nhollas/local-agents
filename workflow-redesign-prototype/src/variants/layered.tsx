// Variant: Layered modules — top-down stack of module zones.
// Emphasises: module boundary diff (what moves, what deletes), at-a-glance scan of every file.
import {
	errorsCode,
	events,
	orchestratorFiles,
	perRunWiringSketch,
	promptScopeShape,
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

export function LayeredVariant() {
	const orchKept = orchestratorFiles.filter((f) => f.side === "orch");
	const orchMoved = orchestratorFiles.filter((f) => f.side === "moved");
	const deletes = orchestratorFiles.filter((f) => f.side === "deleted");

	return (
		<div className="layered">
			<div className="layer">
				<div className="layer-h">
					<h3>
						workflow/ engine <span className="tag engine">target shape</span>
						<span className="tag">{workflowFiles.length} files · flat</span>
					</h3>
					<span className="sub">grouped by role; layout LOCKED</span>
				</div>
				{WORKFLOW_GROUP_ORDER.map((group) => {
					const files = workflowFiles.filter((f) => f.group === group);
					if (files.length === 0) return null;
					return (
						<div key={group} style={{ marginBottom: 10 }}>
							<div
								className="h"
								style={{ marginTop: 8, color: "var(--accent-2)" }}
							>
								{group} ({files.length})
							</div>
							<div className="modules">
								{files.map((f) => (
									<div
										key={f.path}
										className={`module ${
											f.note ? "tbd" : f.movedFrom ? "moved" : "engine"
										}`}
									>
										<div className="file">
											{f.path}
											{f.movedFrom && (
												<span className="tag moved">moved in</span>
											)}
											{f.note && <span className="tag tbd">scaffolding</span>}
										</div>
										<div className="role">{f.role}</div>
										{f.movedFrom && (
											<div className="role" style={{ color: "var(--accent)" }}>
												← from {f.movedFrom}
											</div>
										)}
										{f.note && (
											<div className="role" style={{ color: "var(--tbd)" }}>
												{f.note}
											</div>
										)}
									</div>
								))}
							</div>
						</div>
					);
				})}
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Per-run wiring — the key payoff{" "}
						<span className="tag shared">orchestrator/run-lifecycle.ts</span>
					</h3>
					<span className="sub">
						AgentInvokerLive & WorkflowEventEmitterLive are layer-constructor
						functions exported from workflow/, taking per-run config as
						arguments
					</span>
				</div>
				<CodeBlock code={perRunWiringSketch} />
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Template surfaces — branch / steps / change_request are sibling
						phases <span className="tag engine">one validator walk</span>
					</h3>
					<span className="sub">per-site scope; same algorithm</span>
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

			<div className="layer">
				<div className="layer-h">
					<h3>
						Private internal — <code>runAgentTurn</code>{" "}
						<span className="tag engine">not exported</span>
					</h3>
					<span className="sub">
						the primitive both resolveBranch and runSteps build on
					</span>
				</div>
				<CodeBlock code={runAgentTurnSignature} />
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Errors — 5 tagged errors + 3 unions{" "}
						<span className="tag engine">LOCKED</span>
					</h3>
					<span className="sub">
						definition errors (loadWorkflow) vs execution errors (resolveBranch
						/ runSteps)
					</span>
				</div>
				<CodeBlock code={errorsCode} />
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Service Tags <span className="tag shared">DI boundary</span>
					</h3>
					<span className="sub">
						tag, interface, AND live layer all live in workflow/ — orchestrator
						only constructs & provides per-run
					</span>
				</div>
				<div
					style={{
						display: "grid",
						gridTemplateColumns: "1fr 1fr",
						gap: 12,
					}}
				>
					{tags.map((t) => (
						<div
							key={t.name}
							className="panel"
							style={{ background: "var(--panel-2)" }}
						>
							<div>
								<span className="mono" style={{ color: "var(--accent)" }}>
									{t.name}
								</span>
								<span className="tag">key: {t.tagKey}</span>
								<span className="tag tbd">{t.lifetime}</span>
							</div>
							<div className="sub" style={{ marginTop: 4 }}>
								tag: <code>{t.definedIn}</code> · live: <code>{t.liveIn}</code>
							</div>
							<CodeBlock code={t.iface} />
							<div className="sub">{t.notes}</div>
						</div>
					))}
				</div>
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						orchestrator/ post-redesign{" "}
						<span className="tag orch">consumer side</span>
					</h3>
					<span className="sub">
						{orchKept.length} kept · {orchMoved.length} moved → workflow/ ·{" "}
						{deletes.length} deleted
					</span>
				</div>
				<div className="modules">
					{orchKept.map((f) => (
						<div key={f.path} className="module orch">
							<div className="file">{f.path}</div>
							<div className="role">{f.role}</div>
						</div>
					))}
				</div>
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Moves → workflow/{" "}
						<span className="tag moved">{orchMoved.length}</span>
					</h3>
					<span className="sub">
						content preserved, just relocated — all agent-invocation code lives
						in workflow/
					</span>
				</div>
				<div className="modules">
					{orchMoved.map((f) => (
						<div key={f.path} className="module moved">
							<div className="file">
								{f.path}
								<span className="tag moved">→</span>
							</div>
							<div
								className="role"
								style={{
									color: "var(--accent)",
									fontFamily: "var(--font-mono)",
								}}
							>
								→ {f.movedTo}
							</div>
							<div className="role">{f.role}</div>
						</div>
					))}
				</div>
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						Deletes <span className="tag danger">{deletes.length}</span>
					</h3>
					<span className="sub">
						current orchestrator/ files removed in target (content absorbed
						elsewhere, not relocated)
					</span>
				</div>
				<div className="modules">
					{deletes.map((f) => (
						<div key={f.path} className="module deleted">
							<div className="file">{f.path}</div>
							<div
								className="role"
								style={{
									textDecoration: "none",
									color: "var(--muted)",
								}}
							>
								{f.role}
							</div>
						</div>
					))}
				</div>
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>PromptScope + StepUsage — value objects at the boundary</h3>
					<span className="sub">
						orchestrator translates Issue → PromptScope; engine emits StepUsage
						(per-model)
					</span>
				</div>
				<CodeBlock code={promptScopeShape} />
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>
						WorkflowLayer / makeWorkflowRuntime{" "}
						<span className="tag tbd">MIGRATION SCAFFOLDING</span>
					</h3>
					<span className="sub">{runtimeScaffoldingNote}</span>
				</div>
			</div>

			<div className="layer">
				<div className="layer-h">
					<h3>WorkflowEvent ADT</h3>
					<span className="sub">
						{events.length} variants · one consumer, one match · usage carries
						per-model breakdown
					</span>
				</div>
				<div className="event-list">
					{events.map((e) => (
						<div className="ev" key={e.tag}>
							{e.tag} <span className="src">{e.payload}</span>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
